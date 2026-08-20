import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from './db';
import { optimizeResourceStorage, OPTIMIZE_TARGET_STORES } from './storageOptimize';
import { REF_SOURCE_STORES, runBlobGc } from './blobGc';
import { isBlobRef, getBlobForRef, dataUrlToBlob } from './blobRef';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock } from './maintenanceLock';

// fake-indexeddb 已通过 test-setup.ts 注入。
// 这组用例钉「优化资源存储」的安全边界：只转已接令牌链路的面、原值失败保留、
// 幂等可重跑、目标表必须在 GC 引用面清单内（否则转出的 Blob 会被 GC 当孤儿删）。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 字节内容随意（没人校验 jpeg 魔数），要的只是「另一份不同的 data URL」
const TINY_JPEG = 'data:image/jpeg;base64,AQIDBAUG';

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
    for (const s of ['assets', 'characters', 'songs', 'cc_custom_parts', 'blob_assets']) {
        await clearStore(s);
    }
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
