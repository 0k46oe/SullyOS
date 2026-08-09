/**
 * 一键部署里那几个「错了会静默出事」的地方。
 *
 * 都是踩过或者一眼能看出会踩的坑：密钥漏一条 worker 直接 503、compat flag 少一个
 * 角色调工具就 1042、重装换掉 Master Key 之前排的任务全解不开。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    parseWranglerConfig,
    buildBindings,
    deriveWorkerUrl,
    explainCfError,
    validateSubdomain,
    generateAmsgSecrets,
    scriptNameFromWorkerUrl,
    verifyToken,
    isAccountScopedToken,
    type AmsgSecrets,
} from './cfProvision';

const FULL_SECRETS: AmsgSecrets = {
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_PUBLIC_KEY: 'pub-key',
    VAPID_PRIVATE_KEY: 'priv-key',
    VAPID_EMAIL: 'mailto:someone@example.com',
    AMSG_SERVER_TOKEN: 'server-token',
};

describe('parseWranglerConfig', () => {
    it('认得仓库里那份真的 wrangler.toml，不走兜底', () => {
        const toml = readFileSync(resolve(__dirname, '../worker/amsg/wrangler.toml'), 'utf8');
        const config = parseWranglerConfig(toml);

        // 少了这个 flag，角色到点调自配 MCP 会被当成内网调用拒掉（1042）
        expect(config.compatibilityFlags).toContain('global_fetch_strictly_public');
        // cron 是主动消息唯一的触发方式
        expect(config.crons).toEqual(['* * * * *']);
        expect(config.d1Binding).toBe('DB');
        expect(config.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('注释不会被当成配置读进来', () => {
        const config = parseWranglerConfig(
            [
                '# compatibility_date = "1999-01-01"',
                'compatibility_date = "2026-01-01"  # 真正生效的是这行',
            ].join('\n'),
        );
        expect(config.compatibilityDate).toBe('2026-01-01');
    });

    it('读不出来的项各自回落到兜底值，不返回半份配置', () => {
        const config = parseWranglerConfig('name = "whatever"');

        expect(config.compatibilityFlags).toContain('global_fetch_strictly_public');
        expect(config.crons).toEqual(['* * * * *']);
        expect(config.d1Binding).toBe('DB');
    });

    it('顶层的 binding 键不会被误当成 D1 的 binding', () => {
        const config = parseWranglerConfig(
            ['binding = "NOT_THE_D1_ONE"', '', '[[d1_databases]]', 'binding = "REAL_DB"'].join('\n'),
        );
        expect(config.d1Binding).toBe('REAL_DB');
    });
});

describe('buildBindings', () => {
    it('D1 用 CF 要的 {type,name,id} 形状', () => {
        const bindings = buildBindings('DB', 'db-uuid-1234', FULL_SECRETS);
        expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'db-uuid-1234' });
    });

    /**
     * 回归守卫：新部署必须自带即时对话的起跳器。
     *
     * 漏了它，装出来的 Worker 一发即时对话就 503（instantChat 认的就是这个 binding），
     * 而用户刚走完一键部署，界面上一切正常，只会以为是功能坏了。
     */
    it('自带 INSTANT_TICK 的 Durable Object binding', () => {
        const bindings = buildBindings('DB', 'x', FULL_SECRETS);
        expect(bindings).toContainEqual({
            type: 'durable_object_namespace',
            name: 'INSTANT_TICK',
            class_name: 'InstantTickDO',
        });
    });

    it('五个密钥一条不落——漏一条上去 worker 就起不来', () => {
        const bindings = buildBindings('DB', 'x', FULL_SECRETS);
        const names = bindings.filter((b) => b.type === 'secret_text').map((b) => b.name);

        expect(names).toEqual(
            expect.arrayContaining([
                'AMSG_MASTER_KEY',
                'VAPID_PUBLIC_KEY',
                'VAPID_PRIVATE_KEY',
                'VAPID_EMAIL',
                'AMSG_SERVER_TOKEN',
            ]),
        );
    });

    it('空密钥不写进去：塞空串等于开了一道永远对不上的门', () => {
        const bindings = buildBindings('DB', 'x', {
            ...FULL_SECRETS,
            AMSG_SERVER_TOKEN: '',
            VAPID_EMAIL: '   ',
        });
        const names = bindings.map((b) => b.name);

        expect(names).not.toContain('AMSG_SERVER_TOKEN');
        expect(names).not.toContain('VAPID_EMAIL');
        expect(names).toContain('AMSG_MASTER_KEY');
    });

    it('额外的项（自更新要的 CF token）也走 secret，不是明文', () => {
        const bindings = buildBindings('DB', 'x', FULL_SECRETS, {
            CF_API_TOKEN: 'cf-token',
            CF_SCRIPT_NAME: 'sullyos-amsg',
        });
        const cfToken = bindings.find((b) => b.name === 'CF_API_TOKEN');

        expect(cfToken?.type).toBe('secret_text');
        expect(cfToken?.text).toBe('cf-token');
    });
});

describe('generateAmsgSecrets', () => {
    it('传了已有的 Master Key 就原样保留——换掉会让之前排的任务全解不开', async () => {
        const existing = 'b'.repeat(64);
        const secrets = await generateAmsgSecrets({ AMSG_MASTER_KEY: existing });

        expect(secrets.AMSG_MASTER_KEY).toBe(existing);
    });

    it('传了已有的 VAPID 就原样保留——换掉之前的推送订阅会全部 403', async () => {
        const secrets = await generateAmsgSecrets({
            VAPID_PUBLIC_KEY: 'old-pub',
            VAPID_PRIVATE_KEY: 'old-priv',
        });

        expect(secrets.VAPID_PUBLIC_KEY).toBe('old-pub');
        expect(secrets.VAPID_PRIVATE_KEY).toBe('old-priv');
    });

    it('什么都不传就全新生成，Master Key 是 64 位 hex', async () => {
        const secrets = await generateAmsgSecrets();

        expect(secrets.AMSG_MASTER_KEY).toMatch(/^[0-9a-f]{64}$/);
        expect(secrets.VAPID_PUBLIC_KEY.length).toBeGreaterThan(80);
        expect(secrets.AMSG_SERVER_TOKEN).toBeTruthy();
    });

    it('两次生成不会撞', async () => {
        const a = await generateAmsgSecrets();
        const b = await generateAmsgSecrets();

        expect(a.AMSG_MASTER_KEY).not.toBe(b.AMSG_MASTER_KEY);
        expect(a.VAPID_PUBLIC_KEY).not.toBe(b.VAPID_PUBLIC_KEY);
    });
});

describe('verifyToken', () => {
    /** 装一个假的中转，返回它收到的请求路径。 */
    const stubRelay = (payload: unknown, status = 200) => {
        const paths: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            const relayed = new URL(String(url)).searchParams.get('path');
            if (relayed) paths.push(relayed);
            return new Response(JSON.stringify(payload), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        }));
        return paths;
    };

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('还没到生效日期的 token 要拦下来——CF 这时照样回 success:true', async () => {
        // 放过去的话，后面每一步都收到通用的 Authentication error，会被归成
        // 「权限不够」，用户跑去改权限，可那根本不是原因。真机上踩过一次。
        stubRelay({
            success: true,
            result: { id: 'x', status: 'active', not_before: '2026-08-10T00:00:00Z' },
            messages: [{ code: 10002, message: 'This API Token can not be used before 2026-08-10' }],
        });

        const result = await verifyToken('plain-token');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.code).toBe('TOKEN_NOT_YET_VALID');
            expect(result.message).toContain('2026-08-10');
        }
    });

    it('正常的 token 放行', async () => {
        stubRelay({ success: true, result: { id: 'x', status: 'active' }, messages: [] });

        expect((await verifyToken('plain-token')).ok).toBe(true);
    });

    it('账号令牌当场说清楚该换哪种，而不是拿用户级端点去撞 401', async () => {
        // cfat_ 打 /user/tokens/verify 必然 1000，报错原文只会说 Invalid API Token，
        // 用户对着那句话查不出「你建错了种类」。
        const paths = stubRelay({ success: true });

        const result = await verifyToken('cfat_abcdef');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.code).toBe('TOKEN_INVALID');
            expect(result.message).toContain('API Tokens');
        }
        // 一次网络都不该发
        expect(paths).toHaveLength(0);
    });

    it('普通 token 走用户级端点', async () => {
        const paths = stubRelay({ success: true, result: { status: 'active' }, messages: [] });

        await verifyToken('plain-token');

        expect(paths).toEqual(['/user/tokens/verify']);
    });

    it('认得出账号令牌的前缀', () => {
        expect(isAccountScopedToken('cfat_abc')).toBe(true);
        expect(isAccountScopedToken('  cfat_abc  ')).toBe(true);
        expect(isAccountScopedToken('abcdef123')).toBe(false);
    });
});

describe('explainCfError', () => {
    it('权限不够时把要勾的三项列出来，而不是干说 Unauthorized', () => {
        const msg = explainCfError(403, { errors: [{ code: 9109, message: 'Unauthorized' }] });

        expect(msg).toContain('Workers Scripts:Edit');
        expect(msg).toContain('D1:Edit');
        expect(msg).toContain('Account Settings:Read');
    });

    it('token 格式错（多带了空格换行）单独提示', () => {
        const msg = explainCfError(400, { errors: [{ code: 6111, message: 'Invalid format' }] });
        expect(msg).toContain('空格');
    });

    it('认不出来的错至少把 CF 的原话带上', () => {
        const msg = explainCfError(500, { errors: [{ code: 12345, message: 'Something odd' }] });
        expect(msg).toContain('Something odd');
    });
});

describe('scriptNameFromWorkerUrl', () => {
    it('workers.dev 地址认得出脚本名', () => {
        expect(scriptNameFromWorkerUrl('https://sullyos-amsg.kaede.workers.dev')).toBe('sullyos-amsg');
        expect(scriptNameFromWorkerUrl('https://sullyos-amsg.kaede.workers.dev/')).toBe('sullyos-amsg');
    });

    it('自定义域名和代理门面一律返回 null，不猜', () => {
        // 猜出来的名字会指向账号里另一个 Worker，把钥匙写到别人身上去。
        expect(scriptNameFromWorkerUrl('https://amsg.example.com')).toBeNull();
        expect(scriptNameFromWorkerUrl('https://my-proxy.deno.dev')).toBeNull();
        // 少一段：这是账号子域本身，不是某个脚本
        expect(scriptNameFromWorkerUrl('https://kaede.workers.dev')).toBeNull();
    });

    it('填的不是地址时返回 null 而不是抛错', () => {
        expect(scriptNameFromWorkerUrl('随便写的')).toBeNull();
        expect(scriptNameFromWorkerUrl('')).toBeNull();
    });
});

describe('deriveWorkerUrl / validateSubdomain', () => {
    it('地址是「脚本名.子域.workers.dev」', () => {
        expect(deriveWorkerUrl('sullyos-amsg', 'kaede')).toBe('https://sullyos-amsg.kaede.workers.dev');
    });

    it('合法子域放行', () => {
        expect(validateSubdomain('kaede-123')).toBeNull();
    });

    it('连字符开头结尾、太短、带大写和非法字符都要挡下', () => {
        expect(validateSubdomain('-nope')).not.toBeNull();
        expect(validateSubdomain('nope-')).not.toBeNull();
        expect(validateSubdomain('ab')).not.toBeNull();
        expect(validateSubdomain('has_underscore')).not.toBeNull();
        expect(validateSubdomain('')).not.toBeNull();
    });
});
