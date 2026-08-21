import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DB, openDB } from './db';
import { optimizeResourceStorage, OPTIMIZE_TARGET_STORES } from './storageOptimize';
import { REF_SOURCE_STORES, runBlobGc } from './blobGc';
import { isBlobRef, getBlobForRef, dataUrlToBlob, putImageBlob, clearContentMemo } from './blobRef';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock } from './maintenanceLock';

// fake-indexeddb 已通过 test-setup.ts 注入。
// 这组用例钉「优化资源存储」的安全边界：只转已接令牌链路的面、原值失败保留、
// 幂等可重跑、目标表必须在 GC 引用面清单内（否则转出的 Blob 会被 GC 当孤儿删）。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 字节内容随意（没人校验 jpeg 魔数），要的只是「另一份不同的 data URL」
const TINY_JPEG = 'data:image/jpeg;base64,AQIDBAUG';
// 第三张不同内容的图：气泡主题一侧就有三个图片字段，两张不够摆
const TINY_GIF = 'data:image/gif;base64,BwgJCgsM';

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

beforeEach(async () => {
    for (const s of ['assets', 'characters', 'messages', 'songs', 'cc_custom_parts', 'gallery', 'themes', 'blob_assets', 'memory_vectors']) {
        await clearStore(s);
    }
    localStorage.clear();
    // 内容记忆是模块级的，不清会让上一条用例存的令牌被这条复用，断言全乱
    clearContentMemo();
});

async function blobBytes(token: string): Promise<Uint8Array> {
    const blob = await getBlobForRef(token);
    expect(blob).not.toBeNull();
    return new Uint8Array(await blob!.arrayBuffer());
}

describe('优化资源存储（一次性批量迁移）', () => {
    it('壁纸 assets 行转成令牌，Blob 字节与原图逐一致', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        const r = await optimizeResourceStorage();

        const stored = await DB.getAsset('wallpaper');
        expect(isBlobRef(stored)).toBe(true);
        expect(await blobBytes(stored!)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
        expect(r.bytesBefore).toBe(TINY_PNG.length);
        expect(r.bytesAfter).toBeGreaterThan(0);
    });

    it('同一张图多处引用：全部换成同一令牌，只建一个 Blob', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        await DB.saveCharacter({
            id: 'c1', name: '测试角色',
            roomConfig: { wallImage: TINY_PNG, floorImage: TINY_JPEG, items: [{ id: 'i1', image: TINY_PNG }] },
        } as any);

        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(4);   // wallpaper + wallImage + item + floorImage
        expect(r.uniqueBlobs).toBe(2); // TINY_PNG 一个、TINY_JPEG 一个

        const wallpaperToken = await DB.getAsset('wallpaper');
        const c = (await DB.getAllCharacters()).find(x => x.id === 'c1') as any;
        expect(c.roomConfig.wallImage).toBe(wallpaperToken);
        expect(c.roomConfig.items[0].image).toBe(wallpaperToken);
        expect(isBlobRef(c.roomConfig.floorImage)).toBe(true);
        expect(c.roomConfig.floorImage).not.toBe(wallpaperToken);
    });

    it('songs 封面与捏人器部件（canonical 链路）都转成可解析令牌', async () => {
        await DB.saveSong({ id: 's1', title: '测试曲', coverImage: TINY_JPEG } as any);
        await DB.saveCustomCreatorPart({ id: 'p1', src: TINY_PNG, shadowSrc: TINY_JPEG } as any);

        await optimizeResourceStorage();

        const song = (await DB.getAllSongs()).find(s => s.id === 's1') as any;
        expect(isBlobRef(song.coverImage)).toBe(true);
        expect(await blobBytes(song.coverImage)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));

        const part = (await DB.getCustomCreatorParts()).find(p => p.id === 'p1') as any;
        expect(isBlobRef(part.src)).toBe(true);
        expect(isBlobRef(part.shadowSrc)).toBe(true);
        expect(await blobBytes(part.src)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
    });

    it('外观预设 JSON：壁纸/图标转令牌，其余字段原样、JSON 结构完好', async () => {
        const preset = {
            id: 'ap1', name: '我的预设', createdAt: 1,
            theme: { wallpaper: TINY_PNG, darkMode: true },
            customIcons: { chat: TINY_JPEG },
        };
        await DB.saveAsset('appearance_preset_ap1', JSON.stringify(preset));

        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(2);

        const stored = JSON.parse((await DB.getAsset('appearance_preset_ap1'))!);
        expect(isBlobRef(stored.theme.wallpaper)).toBe(true);
        expect(isBlobRef(stored.customIcons.chat)).toBe(true);
        expect(stored.name).toBe('我的预设');
        expect(stored.theme.darkMode).toBe(true);
    });

    it('相册 gallery 行转成令牌，Blob 字节与原图逐字节一致', async () => {
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });

        const r = await optimizeResourceStorage();

        const stored = (await DB.getGalleryImages()).find(g => g.id === 'g1')!;
        expect(isBlobRef(stored.url)).toBe(true);
        expect(await blobBytes(stored.url)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
    });

    it('相册图和别处引用同一张图：收敛到同一个令牌，只建一个 Blob', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });

        const r = await optimizeResourceStorage();

        const stored = (await DB.getGalleryImages()).find(g => g.id === 'g1')!;
        expect(isBlobRef(stored.url)).toBe(true);
        expect(stored.url).toBe(await DB.getAsset('wallpaper'));
        expect(r.converted).toBe(2);
        expect(r.uniqueBlobs).toBe(1);
    });

    it('相册幂等：第一遍转完，第二遍零转换', async () => {
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(1);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('相册独占引用的图不会被孤儿 GC 删掉（gallery 必须在 GC 的引用面清单里）', async () => {
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });
        await optimizeResourceStorage();
        const token = (await DB.getGalleryImages()).find(g => g.id === 'g1')!.url;
        expect(isBlobRef(token)).toBe(true);

        // 转出来的 Blob 只有相册这一面引用着：GC 看不见这个面就会把它当孤儿删掉，相册全没
        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        expect(await getBlobForRef(token)).not.toBeNull();
    });

    /** 一套气泡主题：两侧各带底纹 / 贴纸 / 头像挂件三张图，外加几个不该被碰的数值字段。 */
    function makeTheme(): any {
        return {
            id: 't1', name: '我的气泡', type: 'custom',
            user: {
                textColor: '#ffffff', backgroundColor: '#6366f1', borderRadius: 20, opacity: 1,
                backgroundImage: TINY_PNG, decoration: TINY_JPEG, avatarDecoration: TINY_GIF,
                decorationX: 88, decorationY: -12, avatarDecorationScale: 1.5,
            },
            ai: {
                textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 16, opacity: 0.9,
                backgroundImage: TINY_GIF, decoration: TINY_PNG, avatarDecoration: TINY_JPEG,
                decorationX: 10, backgroundImageOpacity: 0.35,
            },
        };
    }

    it('气泡主题：两侧六个图片字段都转成令牌，Blob 字节与原图逐字节一致', async () => {
        await DB.saveTheme(makeTheme());

        const r = await optimizeResourceStorage();

        const t = (await DB.getThemes()).find(x => x.id === 't1') as any;
        // 只处理 user 一侧是这一面最容易犯的错，所以两侧逐个字段都要断言
        for (const side of ['user', 'ai']) {
            for (const key of ['backgroundImage', 'decoration', 'avatarDecoration']) {
                expect(isBlobRef(t[side][key])).toBe(true);
            }
        }
        expect(await blobBytes(t.user.backgroundImage)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(await blobBytes(t.user.decoration)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));
        expect(await blobBytes(t.user.avatarDecoration)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_GIF).arrayBuffer()));
        expect(await blobBytes(t.ai.backgroundImage)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_GIF).arrayBuffer()));
        expect(r.converted).toBe(6);
        expect(r.uniqueBlobs).toBe(3);   // 三张不同的图，两侧交叉引用只建三份 Blob
        expect(r.failed).toBe(0);
    });

    it('气泡主题的非图片字段一字不动：颜色、圆角、透明度、贴纸坐标全保持原值', async () => {
        const before = makeTheme();
        await DB.saveTheme(before);

        await optimizeResourceStorage();

        const t = (await DB.getThemes()).find(x => x.id === 't1') as any;
        expect(t.name).toBe('我的气泡');
        expect(t.user.textColor).toBe('#ffffff');
        expect(t.user.backgroundColor).toBe('#6366f1');
        expect(t.user.borderRadius).toBe(20);
        expect(t.user.opacity).toBe(1);
        expect(t.user.decorationX).toBe(88);
        expect(t.user.decorationY).toBe(-12);
        expect(t.user.avatarDecorationScale).toBe(1.5);
        expect(t.ai.borderRadius).toBe(16);
        expect(t.ai.opacity).toBe(0.9);
        expect(t.ai.backgroundImageOpacity).toBe(0.35);
    });

    it('气泡主题幂等：第一遍转完，第二遍零转换', async () => {
        await DB.saveTheme(makeTheme());

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(6);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('气泡主题独占引用的图不会被孤儿 GC 删掉（themes 必须在 GC 的引用面清单里）', async () => {
        await DB.saveTheme(makeTheme());
        await optimizeResourceStorage();
        const t = (await DB.getThemes()).find(x => x.id === 't1') as any;
        const tokens = [t.user.backgroundImage, t.user.decoration, t.user.avatarDecoration];
        for (const token of tokens) expect(isBlobRef(token)).toBe(true);

        // 转出来的 Blob 只有主题这一面引用着：GC 看不见这个面就会把它们全当孤儿删掉
        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        for (const token of tokens) expect(await getBlobForRef(token)).not.toBeNull();
    });

    it('不在清单的字段不动：avatar 的 base64 原样保留（读端还不认令牌）', async () => {
        await DB.saveCharacter({
            id: 'c2', name: '角色', avatar: TINY_PNG,
            roomConfig: { wallImage: TINY_JPEG, items: [] },
        } as any);

        await optimizeResourceStorage();

        const c = (await DB.getAllCharacters()).find(x => x.id === 'c2') as any;
        expect(c.avatar).toBe(TINY_PNG);              // 一字未动
        expect(isBlobRef(c.roomConfig.wallImage)).toBe(true); // 清单内的照转
    });

    it('幂等：第二次运行零转换零新建', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        await optimizeResourceStorage();
        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('坏 data:image 转不动：原值保留、计入 failed，不中断其他面', async () => {
        await DB.saveAsset('wallpaper', 'data:image/png;base64,@@@@');
        await DB.saveAsset('lock_wallpaper', TINY_PNG);

        const r = await optimizeResourceStorage();
        expect(r.failed).toBe(1);
        expect(r.converted).toBe(1);
        expect(await DB.getAsset('wallpaper')).toBe('data:image/png;base64,@@@@');
        expect(isBlobRef(await DB.getAsset('lock_wallpaper'))).toBe(true);
    });

    it('清单守卫：优化写入的每张表都在 GC 引用面清单里（否则转出的 Blob 会被当孤儿删）', () => {
        for (const store of OPTIMIZE_TARGET_STORES) {
            expect(REF_SOURCE_STORES).toContain(store);
        }
    });

    it('维护互斥：锁被占时优化与孤儿 GC 都干净拒绝', async () => {
        expect(tryAcquireMaintenanceLock('测试占用')).toBe(true);
        try {
            await expect(optimizeResourceStorage()).rejects.toThrow(/正在进行/);
            await expect(runBlobGc()).rejects.toThrow(/正在进行/);
        } finally {
            releaseMaintenanceLock();
        }
        // 释放后可正常运行（锁没被拒绝路径污染）
        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(0);
    });
});

describe('去重：同一张图只留一份 Blob', () => {
    it('存量重复：两份一样的 Blob，优化后引用收敛到最老的那个', async () => {
        // 造出历史上两条迁移路径各存各的局面（putImageBlob 本身不去重）
        const older = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const newer = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', older);
        await DB.saveAsset('appearance_preset_1', JSON.stringify({ theme: { wallpaper: newer } }));

        const r = await optimizeResourceStorage();

        expect(await DB.getAsset('wallpaper')).toBe(older);
        expect(JSON.parse((await DB.getAsset('appearance_preset_1'))!).theme.wallpaper).toBe(older);
        expect(r.mergedDuplicates).toBe(1);
        expect(r.reclaimableBytes).toBeGreaterThan(0);
        expect(r.scanUnavailable).toBe(false);
    });

    it('合并只改引用，不删 Blob——多出来那份留给孤儿清理', async () => {
        const older = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const newer = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', older);
        await DB.saveAsset('lock_wallpaper', newer);

        await optimizeResourceStorage();
        expect(await getBlobForRef(newer)).not.toBeNull();

        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.deleted).toBe(1);
        expect(await getBlobForRef(newer)).toBeNull();
        expect(await getBlobForRef(older)).not.toBeNull();
    });

    it('转换时复用库里已有的同内容 Blob，不再存出新的一份', async () => {
        const existing = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('lock_wallpaper', existing);   // 先让它有引用，不是孤儿
        await DB.saveAsset('wallpaper', TINY_PNG);        // 这行还是 base64，等着被转

        const r = await optimizeResourceStorage();

        expect(await DB.getAsset('wallpaper')).toBe(existing);
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(0);   // 一个新 Blob 都没建
        expect(r.bytesAfter).toBe(0);
    });

    it('被「换图即删」字段引用的令牌整组跳过合并（否则对方一删这边就破图）', async () => {
        const wallpaperRef = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const stageRef = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', wallpaperRef);
        // videoCallBackground 换图时是裸删旧 Blob 的
        await DB.saveCharacter({ id: 'c1', name: '测试角色', videoCallBackground: stageRef } as any);

        const r = await optimizeResourceStorage();

        expect(await DB.getAsset('wallpaper')).toBe(wallpaperRef);
        expect(((await DB.getAllCharacters())[0] as any).videoCallBackground).toBe(stageRef);
        expect(r.mergedDuplicates).toBe(0);
        expect(r.skippedGroups).toBe(1);
    });

    it('合并跑完是幂等的：再点一次没有重复可合', async () => {
        const older = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const newer = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', older);
        await DB.saveAsset('lock_wallpaper', newer);

        await optimizeResourceStorage();
        const second = await optimizeResourceStorage();
        expect(second.mergedDuplicates).toBe(0);
        expect(second.converted).toBe(0);
    });
});

describe('记忆向量：压成紧凑形态', () => {
    /** 直接塞一条旧 number[] 形态的向量（绕开 MemoryVectorDB.save，它会当场转成紧凑形态）。 */
    async function seedLegacyVector(memoryId: string, charId: string, dims: number): Promise<number[]> {
        const vector = Array.from({ length: dims }, (_, i) => (i % 7) / 7 - 0.5);
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('memory_vectors', 'readwrite');
            tx.objectStore('memory_vectors').put({ memoryId, charId, vector, dimensions: dims });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        return vector;
    }

    async function readRawVector(memoryId: string): Promise<any> {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction('memory_vectors', 'readonly').objectStore('memory_vectors').get(memoryId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    it('一键优化会把旧 number[] 向量压成紧凑字节，数值逐位不变', async () => {
        const original = await seedLegacyVector('m1', 'c1', 16);

        const r = await optimizeResourceStorage();

        expect(r.vectorsCompacted).toBe(1);
        expect(r.vectorError).toBeNull();
        const stored = await readRawVector('m1');
        expect(ArrayBuffer.isView(stored.vector)).toBe(true);
        // Float32 精度内逐位一致：压缩必须是无损的，否则召回质量会静默退化
        const back = new Float32Array(stored.vector.buffer, stored.vector.byteOffset, stored.vector.byteLength >>> 2);
        expect(back.length).toBe(original.length);
        for (let i = 0; i < original.length; i++) {
            expect(back[i]).toBeCloseTo(original[i], 6);
        }
    });

    it('幂等：已是紧凑形态的再点一次不重复计数', async () => {
        await seedLegacyVector('m1', 'c1', 16);
        await optimizeResourceStorage();
        const second = await optimizeResourceStorage();
        expect(second.vectorsCompacted).toBe(0);
        expect(second.vectorError).toBeNull();
    });

    it('向量这步失败不吞、也不连累图片那几步的成果', async () => {
        const mp = await import('./memoryPalace/db');
        const spy = vi.spyOn(mp.MemoryVectorDB, 'scanAndMigrateLegacy')
            .mockRejectedValue(new Error('磁盘满了'));
        try {
            await DB.saveAsset('wallpaper', TINY_PNG);

            const r = await optimizeResourceStorage();

            // 图片照转完，结果照报
            expect(r.converted).toBe(1);
            expect(isBlobRef(await DB.getAsset('wallpaper'))).toBe(true);
            // 向量的失败原样带出来（开机那次后台扫描就是只 console.warn，卡住了没人知道）
            expect(r.vectorsCompacted).toBe(0);
            expect(r.vectorError).toContain('磁盘满了');
        } finally {
            spy.mockRestore();
        }
    });
});

describe('分页读表：跨页不漏行，进度条对得上', () => {
    // 这五面原本是整表 getAll 的，行都在一个数组里，怎么写都不会漏。改成按主键翻页之后，
    // 「只跑了第一批就退出」「翻页起点取错」这类毛病在小库上一条都不会红，而漏掉的行
    // 就是没被转换的存量图。这组用例把跨页和进度口径钉住。
    const PAGE = 200; // 与 storageOptimize.ts 的 PAGE_SIZE 一致

    async function seedStore(name: string, records: any[]): Promise<void> {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(name, 'readwrite');
            const store = tx.objectStore(name);
            for (const r of records) store.put(r);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    it('相册行数超过一页：跨页每一行都转到，一条不漏', async () => {
        const count = PAGE + 50;
        await seedStore('gallery', Array.from({ length: count }, (_, i) => ({
            id: `g${String(i + 1).padStart(4, '0')}`, charId: 'c1', url: TINY_PNG, timestamp: i + 1,
        })));

        const r = await optimizeResourceStorage();

        const rows = await DB.getGalleryImages();
        expect(rows.length).toBe(count);
        // 第 2 页起漏掉任何一行，这里就是一堆还留着 data: 的相册图
        expect(rows.filter(g => isBlobRef(g.url)).length).toBe(count);
        expect(r.converted).toBe(count);
        expect(r.uniqueBlobs).toBe(1); // 全是同一张图，去重后只建一份 Blob
    });

    it('进度回调：total 就是六面的真实行数，done 一路递增且正好停在 total', async () => {
        // 六个面各摆几行、行数互不相同——少数了哪一面都对不上
        await DB.saveAsset('wallpaper', TINY_PNG);
        await DB.saveAsset('lock_wallpaper', TINY_JPEG);
        await seedStore('characters', [
            { id: 'c1', name: '角色一', roomConfig: { wallImage: TINY_PNG, items: [] } },
            { id: 'c2', name: '角色二' },
            { id: 'c3', name: '角色三' },
        ]);
        await seedStore('songs', [{ id: 's1', title: '测试曲', coverImage: TINY_JPEG }]);
        await seedStore('cc_custom_parts', [
            { id: 'p1', src: TINY_PNG, createdAt: 1 },
            { id: 'p2', src: TINY_JPEG, createdAt: 2 },
        ]);
        await seedStore('gallery', [
            { id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 },
            { id: 'g2', charId: 'c1', url: TINY_JPEG, timestamp: 2 },
            { id: 'g3', charId: 'c1', url: TINY_PNG, timestamp: 3 },
            { id: 'g4', charId: 'c1', url: TINY_JPEG, timestamp: 4 },
        ]);
        await seedStore('themes', [
            { id: 't1', name: '气泡一', type: 'custom', user: { backgroundImage: TINY_PNG }, ai: {} },
            { id: 't2', name: '气泡二', type: 'custom', user: {}, ai: { decoration: TINY_GIF } },
            { id: 't3', name: '气泡三', type: 'custom', user: {}, ai: {} },
            { id: 't4', name: '气泡四', type: 'custom', user: {}, ai: {} },
            { id: 't5', name: '气泡五', type: 'custom', user: {}, ai: {} },
        ]);
        const expectedRows = 2 + 3 + 1 + 2 + 4 + 5;

        // 只收六面自己报的那几档：扫库 / 合并 / 向量三段各有各的进度口径，混进来会算错
        const faceLabels = new Set(['系统外观', '小屋', '歌曲封面', '捏人器部件', '相册', '气泡主题']);
        const events: Array<{ done: number; total: number }> = [];
        await optimizeResourceStorage(p => {
            if (faceLabels.has(p.label)) events.push({ done: p.done, total: p.total });
        });

        expect(events.length).toBe(expectedRows);                   // 每行恰好报一次
        for (const e of events) expect(e.total).toBe(expectedRows); // 总数不是估的
        // done 从 1 数到 total：不倒退、不跳号、不越过
        expect(events.map(e => e.done)).toEqual(Array.from({ length: expectedRows }, (_, i) => i + 1));
    });
});

describe('气泡主题导出：分享文件里不能留令牌', () => {
    // 工坊导出的 .sully-bubble.json 是给别人的，令牌只有本机认得——原样导出，对方导进去
    // 拿到的是一串死字符串，三张图全空，还没有任何报错。所以导出前必须在深拷贝上跑一遍
    // resolveBlobRefsDeep 把令牌换回内嵌 data URL。
    // 真调一次得把整个工坊界面渲染起来，代价太大，这里用源码锚：改坏导出这条就挂。
    const themeMakerSrc = readFileSync(new URL('../apps/ThemeMaker.tsx', import.meta.url), 'utf8');

    /** 截出 exportSavedTheme 的函数体（到第一处同缩进的收尾 `};` 为止）。 */
    function exportFnBody(): string {
        const start = themeMakerSrc.indexOf('const exportSavedTheme');
        expect(start).toBeGreaterThan(-1);
        const end = themeMakerSrc.indexOf('\n    };', start);
        expect(end).toBeGreaterThan(start);
        return themeMakerSrc.slice(start, end);
    }

    it('导出前解析令牌，解析的是副本、写进文件的也是那份副本', () => {
        const body = exportFnBody();
        // 一、真的解析了
        const resolved = /await resolveBlobRefsDeep\((\w+)\)/.exec(body);
        expect(resolved).not.toBeNull();
        const copyName = resolved![1];
        // 二、解析的不是库里那份（resolveBlobRefsDeep 原地改对象，喂 theme 等于把用户的主题改空）
        expect(copyName).not.toBe('theme');
        expect(body).toMatch(new RegExp(`const ${copyName} = cloneTheme\\(`));
        // 三、序列化进文件的是解析过的那份，不是原始入参
        expect(body).toMatch(new RegExp(`theme:\\s*${copyName}\\b`));
        expect(body.indexOf('resolveBlobRefsDeep')).toBeLessThan(body.indexOf('JSON.stringify'));
    });

    it('工坊上传的图存的是令牌，不是 base64', () => {
        const start = themeMakerSrc.indexOf('const handleImageUpload');
        expect(start).toBeGreaterThan(-1);
        const body = themeMakerSrc.slice(start, themeMakerSrc.indexOf('\n    };', start));
        // processImage 给的是 data URL，得再过一道 migrateDataUrlToRef 才进主题
        expect(body).toMatch(/await migrateDataUrlToRef\(/);
        expect(body).not.toMatch(/updateStyle\('(backgroundImage|decoration|avatarDecoration)', result\)/);
    });
});
