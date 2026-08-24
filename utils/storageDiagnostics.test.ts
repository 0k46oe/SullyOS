import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDB } from './db';
import { OPTIMIZE_TARGET_STORES } from './storageOptimize';
import { clearContentMemo } from './blobRef';
import { blobStore } from './blobStore';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock } from './maintenanceLock';
import {
    scanStorageSnapshot, runStorageDiagnostics, sanitizeIssueText, saveReport, loadSavedReport,
    clearSavedReport, normalizeRowId, blobFamilyOf, summarizeReport, sanitizeReasons, DIAG_REPORT_KEY,
    type StorageSnapshot, type FieldStat,
} from './storageDiagnostics';

// fake-indexeddb 由 test-setup.ts 注入。
//
// 这组用例存在的唯一理由：**证明诊断扫的路径跟库里真实的字段位置是同一处**。
// 「写了个不存在的路径 → 一条都没统计到 → 报告一片零 → 看起来像『存储很干净』」
// 是这个功能最要命也最难自己发现的失败模式，所以下面对每个面都做精确路径断言，
// 并且用真正的 optimizeResourceStorage() 跑一遍端到端，让扫描器和优化器互相印证。

/** 每张图内容都不同：内容相同的会被去重合并成一份，那样令牌计数就对不上了。 */
function tinyImage(seed: string, mime = 'png'): string {
    const body = Buffer.from(`sullyos-diag-${seed}`).toString('base64');
    return `data:image/${mime};base64,${body}`;
}

// 清库范围跟着一键优化的覆盖面走：那边新收一张表，这边自动跟上。
// 手写一份清单的话，漏掉的那张表不会报错——只是上一条用例的行漏进下一条，
// 让某个不相干的用例莫名其妙多数出一行来。
const SEEDED_STORES = [...new Set([...OPTIMIZE_TARGET_STORES, 'blob_assets', 'memory_vectors'])];

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function seedStore(name: string, records: unknown[]): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** 取某张表某条路径的统计槽；找不到就是「这个面没扫到」，直接让断言带着路径名报错。 */
function field(snapshot: StorageSnapshot, store: string, path: string): FieldStat {
    const hit = snapshot.fields.find(f => f.store === store && f.path === path);
    if (!hit) {
        const sameStore = snapshot.fields.filter(f => f.store === store).map(f => f.path);
        throw new Error(`没扫到 ${store} 的路径 ${path}；这张表实际扫出来的是：${sameStore.join(', ') || '(一条都没有)'}`);
    }
    return hit;
}

beforeEach(async () => {
    for (const name of SEEDED_STORES) await clearStore(name);
    localStorage.clear();
    clearContentMemo();
});

afterEach(() => {
    releaseMaintenanceLock();
    clearSavedReport();
});

describe('存储诊断 · 扫描器认得出库里每个面', () => {
    it('九个优化覆盖面各塞一张 base64，扫描逐条路径都能对上号', async () => {
        await seedStore('assets', [
            { id: 'wallpaper', data: tinyImage('wallpaper') },
            { id: 'icon_calculator', data: tinyImage('icon') },
            { id: 'appearance_preset_1712345678901', data: JSON.stringify({
                theme: { wallpaper: tinyImage('preset-wall') },
                customIcons: { chat: tinyImage('preset-icon') },
            }) },
            { id: 'room_custom_assets_list', data: JSON.stringify([{ image: tinyImage('room-asset') }]) },
        ]);
        await seedStore('characters', [{
            id: 'c1', name: '角色一', avatar: tinyImage('char-avatar'),
            roomConfig: {
                wallImage: tinyImage('wall'), floorImage: tinyImage('floor'),
                items: [{ id: 'i1', image: tinyImage('item') }],
            },
        }]);
        await seedStore('songs', [{ id: 's1', title: '测试曲', coverImage: tinyImage('cover', 'jpeg') }]);
        await seedStore('cc_custom_parts', [{ id: 'p1', src: tinyImage('part'), shadowSrc: tinyImage('shadow'), createdAt: 1 }]);
        await seedStore('gallery', [{ id: 'g1', charId: 'c1', url: tinyImage('gallery'), timestamp: 1 }]);
        await seedStore('themes', [{
            id: 't1', name: '气泡一', type: 'custom',
            user: { backgroundImage: tinyImage('theme-user-bg') },
            ai: { decoration: tinyImage('theme-ai-deco'), avatarDecoration: tinyImage('theme-ai-avatar') },
        }]);
        await seedStore('messages', [
            { id: 1, charId: 'c1', role: 'user', type: 'image', content: tinyImage('msg'), timestamp: 1 },
            { id: 2, charId: 'c1', role: 'user', type: 'text', content: '一句普通的话', timestamp: 2 },
        ]);
        await seedStore('emojis', [
            { name: '本地表情', url: tinyImage('emoji', 'gif') },
            { name: '网络表情', url: 'https://img.example/sticker.png' },
        ]);
        await seedStore('user_profile', [{
            id: 'me', name: '小明', avatar: tinyImage('me'),
            perCharAvatars: { c1: tinyImage('me-for-c1') },
        }]);

        const snapshot = await scanStorageSnapshot();

        // ── 逐面精确路径：这几行就是「收集脚本和 IDB 对得上」的证据 ──
        expect(field(snapshot, 'assets', '[wallpaper].data').base64Count).toBe(1);
        expect(field(snapshot, 'assets', '[icon_*].data').base64Count).toBe(1);
        expect(field(snapshot, 'assets', '[appearance_preset_*].data(json).theme.wallpaper').base64Count).toBe(1);
        expect(field(snapshot, 'assets', '[appearance_preset_*].data(json).customIcons.chat').base64Count).toBe(1);
        expect(field(snapshot, 'assets', '[room_custom_assets_list].data(json)[].image').base64Count).toBe(1);
        expect(field(snapshot, 'characters', 'avatar').base64Count).toBe(1);
        expect(field(snapshot, 'characters', 'roomConfig.wallImage').base64Count).toBe(1);
        expect(field(snapshot, 'characters', 'roomConfig.floorImage').base64Count).toBe(1);
        expect(field(snapshot, 'characters', 'roomConfig.items[].image').base64Count).toBe(1);
        expect(field(snapshot, 'songs', 'coverImage').base64Count).toBe(1);
        expect(field(snapshot, 'cc_custom_parts', 'src').base64Count).toBe(1);
        expect(field(snapshot, 'cc_custom_parts', 'shadowSrc').base64Count).toBe(1);
        expect(field(snapshot, 'gallery', 'url').base64Count).toBe(1);
        expect(field(snapshot, 'themes', 'user.backgroundImage').base64Count).toBe(1);
        expect(field(snapshot, 'themes', 'ai.decoration').base64Count).toBe(1);
        expect(field(snapshot, 'themes', 'ai.avatarDecoration').base64Count).toBe(1);
        expect(field(snapshot, 'messages', 'content').base64Count).toBe(1);
        expect(field(snapshot, 'emojis', 'url').base64Count).toBe(1);
        expect(field(snapshot, 'user_profile', 'avatar').base64Count).toBe(1);
        expect(field(snapshot, 'user_profile', 'perCharAvatars.c1').base64Count).toBe(1);

        // 外链既不该算成 base64，也不能不算数
        expect(field(snapshot, 'emojis', 'url').httpCount).toBe(1);
        // 普通文本消息不该被当图（messages.content 那条槽是两条消息共用的）
        expect(field(snapshot, 'messages', 'content').hits).toBe(2);

        expect(snapshot.totals.base64Count).toBe(20);
        expect(snapshot.totals.base64Bytes).toBeGreaterThan(0);
        expect(snapshot.totals.blobRefCount).toBe(0);
    });

    it('优化覆盖的每张表都在扫描视野里（漏一张就等于那个面白测）', async () => {
        for (const store of OPTIMIZE_TARGET_STORES) {
            await seedStore(store, [store === 'emojis'
                ? { name: `probe-${store}`, url: tinyImage(`probe-${store}`) }
                : { id: `probe-${store}`, data: tinyImage(`probe-${store}`) }]);
        }
        const snapshot = await scanStorageSnapshot();
        for (const store of OPTIMIZE_TARGET_STORES) {
            const scanned = snapshot.stores.find(s => s.store === store);
            expect(scanned, `${store} 没进扫描结果`).toBeDefined();
            expect(scanned!.scanned, `${store} 一行都没扫`).toBeGreaterThan(0);
            expect(scanned!.error, `${store} 扫的时候报错了`).toBeUndefined();
        }
    });

    it('字段多的结构体不会被折叠成 *，只有 id 当键的那种表才折叠', async () => {
        // 这条是回归守卫：早先按「key 个数」判折叠，CharacterProfile 顶层十几个字段直接
        // 被判成 map，avatar / roomConfig.wallImage 全糊成 *，报告等于废了。
        await seedStore('characters', [{
            id: 'c1', name: 'n', persona: 'p', greeting: 'g', tags: [], createdAt: 1, updatedAt: 2,
            favorability: 0, mood: 'x', worldbookIds: [], modelName: 'm', temperature: 1,
            voiceId: 'v', timezone: 'Asia/Shanghai',
            avatar: tinyImage('deep-avatar'),
        }]);
        await seedStore('user_profile', [{
            id: 'me',
            perCharAvatars: Object.fromEntries(
                Array.from({ length: 6 }, (_, i) => [`char_17123456789${i}0`, tinyImage(`pc-${i}`)]),
            ),
        }]);

        const snapshot = await scanStorageSnapshot();
        expect(field(snapshot, 'characters', 'avatar').base64Count).toBe(1);
        // 随机 id 当键的那张表照旧折叠，不然六个 charId 就是六条路径
        expect(field(snapshot, 'user_profile', 'perCharAvatars.*').base64Count).toBe(6);
    });

    it('localStorage 里的令牌算作引用，不会把活图误判成孤儿', async () => {
        const token = await blobStore.put(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
        localStorage.setItem('acnh_wallpaper_backup', token);
        localStorage.setItem('os_theme', JSON.stringify({ wallpaper: token }));

        const snapshot = await scanStorageSnapshot();
        expect(snapshot.localStorage?.keyCount).toBe(2);
        expect(snapshot.localStorage?.entries.some(e => e.blobRefCount > 0)).toBe(true);
        expect(snapshot.blobs?.orphanCount).toBe(0);
        expect(snapshot.blobs?.danglingCount).toBe(0);
    });

    it('引用指向不存在的图会被报成破图，没人引用的图会被报成孤儿', async () => {
        const live = await blobStore.put(new Blob([new Uint8Array([9, 9])], { type: 'image/png' }));
        await blobStore.put(new Blob([new Uint8Array([8, 8, 8])], { type: 'image/png' })); // 谁也不引用
        await seedStore('characters', [
            { id: 'c1', name: '有图的', avatar: live },
            { id: 'c2', name: '图没了的', avatar: 'blobref:b_thisoneisgone' },
        ]);

        const snapshot = await scanStorageSnapshot();
        expect(snapshot.blobs?.orphanCount).toBe(1);
        expect(snapshot.blobs?.orphanBytes).toBe(3);
        expect(snapshot.blobs?.danglingCount).toBe(1);
        expect(snapshot.blobs?.danglingSamples).toContain('b_thisoneisgone');
    });

    it('报告里不留用户内容：聊天正文、角色名、localStorage 的值都不进快照', async () => {
        await seedStore('messages', [
            { id: 1, charId: 'c1', role: 'user', type: 'text', content: '这句话是用户的隐私内容', timestamp: 1 },
        ]);
        await seedStore('characters', [{ id: 'c1', name: '某个角色的名字', persona: '设定里的秘密' }]);
        localStorage.setItem('api_config', JSON.stringify({ key: 'sk-abcdefghijklmn' }));

        const snapshot = await scanStorageSnapshot();
        const dumped = JSON.stringify(snapshot);
        expect(dumped).not.toContain('隐私内容');
        expect(dumped).not.toContain('某个角色的名字');
        expect(dumped).not.toContain('设定里的秘密');
        expect(dumped).not.toContain('sk-abcdefghijklmn');
        // 键名本身要留着（要知道是哪个键占地方），值不许留
        expect(snapshot.localStorage?.entries.some(e => e.key === 'api_config')).toBe(true);
    });
});

describe('存储诊断 · 端到端跑真正的一键优化', () => {
    it('这轮新收的字段，诊断一个不漏地看得见，优化后一条 base64 都不剩', async () => {
        // 诊断扫的是 db.objectStoreNames（全库），字段路径靠递归发现而不是写死，
        // 所以「一键优化」收录面一扩，它自动跟上。这条用例把新收的字段各摆一份，
        // 钉住「优化器转走的」和「诊断扫到的」是同一批——两边各算各的，对得上才算数。
        // 将来再收新字段时，往这里补一份 seed 就能立刻知道诊断跟没跟上。
        await seedStore('characters', [{
            id: 'c1', name: '角色一',
            chatBackground: tinyImage('chat-bg'),
            dateBackground: tinyImage('date-bg'),
            sprites: { normal: tinyImage('sprite-normal') },
            dateSkinSets: [{ id: 'sk1', name: '泳装', sprites: { happy: tinyImage('skin-happy') } }],
            vrState: { chibi: { img: tinyImage('char-chibi') } },
            phoneState: { contacts: [{ id: 'ct1', name: '甲', avatar: tinyImage('contact') }] },
            specialMomentRecords: {
                whiteday_2026: {
                    image: tinyImage('moment-img'),
                    customData: { chatCard: { charAvatar: tinyImage('card-avatar') } },
                },
            },
        }]);
        await seedStore('user_profile', [{ id: 'me', name: '小明', vrState: { chibi: { img: tinyImage('my-chibi') } } }]);
        await seedStore('social_posts', [{
            id: 'p1', authorName: '甲', authorAvatar: tinyImage('post-author'), images: [], timestamp: 1,
            comments: [{ id: 'cm1', authorName: '乙', authorAvatar: tinyImage('comment-author') }],
        }]);
        await seedStore('groups', [{ id: 'g1', name: '群一', avatar: tinyImage('group') }]);
        await seedStore('life_sim', [{ id: 'ls1', actionLog: [{ turnNumber: 1, actor: '甲', actorAvatar: tinyImage('actor') }] }]);
        await seedStore('messages', [{
            id: 1, charId: 'c1', role: 'assistant', type: 'score_card', timestamp: 1,
            content: JSON.stringify({ charAvatar: tinyImage('card-content'), photoDataUrl: tinyImage('photo') }),
            metadata: {
                characterAvatar: tinyImage('call-avatar'),
                scoreCard: { charAvatar: tinyImage('card-meta'), photoDataUrl: tinyImage('photo-meta') },
                post: {
                    authorName: '甲', authorAvatar: tinyImage('shared-author'), images: [],
                    comments: [{ authorName: '乙', authorAvatar: tinyImage('shared-comment') }],
                },
            },
        }]);
        await seedStore('assets', [
            { id: 'widget_dsq', data: tinyImage('widget') },
            { id: 'spark_user_bg', data: tinyImage('spark-bg') },
            { id: 'spark_social_profile', data: JSON.stringify({ name: '小明', avatar: tinyImage('spark-avatar') }) },
            { id: 'appearance_preset_ap1', data: JSON.stringify({
                id: 'ap1', name: '预设', createdAt: 1,
                theme: { wallpaper: 'linear-gradient(#fff,#000)', launcherWidgets: { dsq: tinyImage('preset-widget') } },
                chatThemes: [{
                    id: 'ct1', name: '气泡', type: 'custom',
                    user: { decoration: tinyImage('preset-bubble-user') },
                    ai: { avatarDecoration: tinyImage('preset-bubble-ai') },
                }],
            }) },
        ]);

        const report = await runStorageDiagnostics();

        expect(report.optimize.ok, report.optimize.error ?? '').toBe(true);
        // 优化后一条 base64 都不剩——哪个字段没被收录，它就会留在 base64Left 里点名
        expect(report.delta!.base64Left).toEqual([]);
        expect(report.after!.totals.base64Count).toBe(0);
        // 两边各算各的，对得上才说明看的是同一批数据
        expect(report.optimize.result!.converted).toBe(report.before!.totals.base64Count);
    });

    it('优化前扫到的 base64，优化后原地变成令牌，字节账对得上', async () => {
        await seedStore('characters', [{ id: 'c1', name: '角色一', avatar: tinyImage('e2e-avatar') }]);
        await seedStore('gallery', [
            { id: 'g1', charId: 'c1', url: tinyImage('e2e-g1'), timestamp: 1 },
            { id: 'g2', charId: 'c1', url: tinyImage('e2e-g2'), timestamp: 2 },
        ]);
        await seedStore('messages', [
            { id: 1, charId: 'c1', role: 'user', type: 'image', content: tinyImage('e2e-msg'), timestamp: 1 },
        ]);

        const report = await runStorageDiagnostics();

        expect(report.optimize.ok, report.optimize.error ?? '').toBe(true);
        expect(report.before!.totals.base64Count).toBe(4);
        expect(report.before!.totals.blobRefCount).toBe(0);

        // 优化器自己报的转换数，跟扫描器前后看到的差额必须是同一个数——两边各算各的，
        // 对得上才说明它们看的是同一批数据。
        expect(report.optimize.result!.converted).toBe(4);
        expect(report.after!.totals.base64Count).toBe(0);
        expect(report.after!.totals.blobRefCount).toBe(4);
        expect(report.delta!.base64Count).toEqual({ before: 4, after: 0 });
        expect(report.delta!.base64Left).toEqual([]);

        // 转出来的图必须都有人引用、也都真在库里：一个孤儿零个破图
        expect(report.after!.blobs?.danglingCount).toBe(0);
        expect(report.after!.blobs?.orphanCount).toBe(0);
        expect(report.after!.blobs!.total).toBe(4);

        // 优化后的字段路径还在原地（转的是值，不是搬字段）
        expect(field(report.after!, 'characters', 'avatar').blobRefCount).toBe(1);
        expect(field(report.after!, 'gallery', 'url').blobRefCount).toBe(2);
        expect(field(report.after!, 'messages', 'content').blobRefCount).toBe(1);

        expect(report.steps.every(s => s.ok)).toBe(true);
        expect(report.app.version).toBeTruthy();
    });

    it('转不动的图会把原因带进报告，且原因也过脱敏', async () => {
        await seedStore('assets', [{ id: 'wallpaper', data: 'data:image/png;base64,@@@@' }]);

        const report = await runStorageDiagnostics();

        expect(report.optimize.result!.failed).toBe(1);
        const reasons = Object.keys(report.optimize.result!.failureReasons);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain('系统外观');
        // 转不成的那张图还在原地，扫描后照样看得见
        expect(report.after!.totals.base64Count).toBe(1);
        expect(summarizeReport(report).some(l => l.includes('转不动的原因'))).toBe(true);
    });

    it('优化没跑成的时候，优化前后的扫描结果照样进报告', async () => {
        // 拿住维护锁，让 optimizeResourceStorage 走它自己的「另一项维护正在进行」那条路，
        // 不用 mock —— 测的就是真实的失败路径。
        await seedStore('gallery', [{ id: 'g1', charId: 'c1', url: tinyImage('locked'), timestamp: 1 }]);
        expect(tryAcquireMaintenanceLock('测试占位')).toBe(true);

        const report = await runStorageDiagnostics();

        expect(report.optimize.ok).toBe(false);
        expect(report.optimize.error).toContain('维护');
        expect(report.before!.totals.base64Count).toBe(1);
        expect(report.after!.totals.base64Count).toBe(1);   // 没转成，图还在原样
        expect(report.captured.some(c => c.source === 'optimize')).toBe(true);
        expect(report.steps.find(s => s.name === '一键优化')?.ok).toBe(false);
    });
});

describe('存储诊断 · 脱敏与存盘', () => {
    it('报错文本里的 data URL 只留长度，含疑似密钥的整条隐去', () => {
        const withImage = sanitizeIssueText(`转换失败 data:image/png;base64,${'A'.repeat(500)} 之后就挂了`);
        expect(withImage).not.toContain('AAAA');
        expect(withImage).toContain('字符');

        expect(sanitizeIssueText('request failed: Authorization: Bearer abc123')).toBe('[已隐去一条含疑似密钥的报错]');
        expect(sanitizeIssueText('api_key 无效')).toBe('[已隐去一条含疑似密钥的报错]');
        expect(sanitizeIssueText('普通的一条报错')).toBe('普通的一条报错');
    });

    it('失败原因逐条脱敏，脱敏后撞成一句的合并计数', () => {
        expect(sanitizeReasons({
            '相册: InvalidCharacterError': 3,
            'api_key 泄露了一号': 1,
            'api_key 泄露了二号': 2,
        })).toEqual({
            '相册: InvalidCharacterError': 3,
            '[已隐去一条含疑似密钥的报错]': 3,
        });
        expect(sanitizeReasons({})).toEqual({});
    });

    it('报告存得下就整份存，存不下就逐级瘦身，最后只剩摘要也算存住', async () => {
        await seedStore('gallery', [{ id: 'g1', charId: 'c1', url: tinyImage('save'), timestamp: 1 }]);
        const report = await runStorageDiagnostics();

        expect(saveReport(report)).toEqual({ saved: true, degraded: false });
        const loaded = loadSavedReport();
        expect(loaded?.kind).toBe('sullyos-storage-diagnostics');
        expect(loaded?.before?.totals.base64Count).toBe(1);

        // 模拟「localStorage 满了」：整份写不进，瘦身版能写进
        const origSetItem = localStorage.setItem.bind(localStorage);
        let calls = 0;
        localStorage.setItem = (k: string, v: string) => {
            calls++;
            if (calls === 1) throw new DOMException('quota', 'QuotaExceededError');
            origSetItem(k, v);
        };
        try {
            expect(saveReport(report)).toEqual({ saved: true, degraded: true });
        } finally {
            localStorage.setItem = origSetItem;
        }
        expect(localStorage.getItem(DIAG_REPORT_KEY)).toBeTruthy();
    });

    it('存坏了的报告读出来是 null，不会把界面带崩', () => {
        localStorage.setItem(DIAG_REPORT_KEY, '{不是合法 JSON');
        expect(loadSavedReport()).toBeNull();
        localStorage.setItem(DIAG_REPORT_KEY, JSON.stringify({ kind: '别的东西' }));
        expect(loadSavedReport()).toBeNull();
    });
});

describe('存储诊断 · 小工具', () => {
    it('行主键里的随机段折叠掉，固定名字原样留着', () => {
        expect(normalizeRowId('wallpaper')).toBe('wallpaper');
        expect(normalizeRowId('room_custom_assets_list')).toBe('room_custom_assets_list');
        expect(normalizeRowId('icon_calculator')).toBe('icon_*');
        expect(normalizeRowId('appearance_preset_1712345678901')).toBe('appearance_preset_*');
        expect(normalizeRowId('tama_board_img_char_1712345678901')).toBe('tama_board_img_*');
    });

    it('blob_assets 是混用表，id 前缀分得出图片和模型', () => {
        expect(blobFamilyOf('b_abc123')).toContain('图片');
        expect(blobFamilyOf('img_legacy1')).toContain('图片');
        expect(blobFamilyOf('video-avatar-1234')).toBe('VRM 模型');
        expect(blobFamilyOf('someid:live2d-runtime-store-v1')).toBe('Live2D 缓存');
    });
});
