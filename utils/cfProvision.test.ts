/**
 * 一键部署里那几个「错了会静默出事」的地方。
 *
 * 都是踩过或者一眼能看出会踩的坑：密钥漏一条 worker 直接 503、compat flag 少一个
 * 角色调工具就 1042、重装换掉 Master Key 之前排的任务全解不开。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    parseWranglerConfig,
    buildBindings,
    deriveWorkerUrl,
    explainCfError,
    validateSubdomain,
    generateAmsgSecrets,
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
