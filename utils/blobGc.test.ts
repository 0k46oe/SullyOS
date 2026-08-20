import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DB, openDB } from './db';
import { runBlobGc, REF_SOURCE_STORES } from './blobGc';
import { putImageBlob, getBlobForRef, dataUrlToBlob } from './blobRef';

// fake-indexeddb 已由 test-setup.ts 注入。这组用例钉住孤儿 GC 的四条生死线：
//   1. 混用表守卫（最重要）：blob_assets 里混居着 VRM 模型 / Live2D 运行时缓存 /
//      遗留陪伴语音，GC 的世界观必须被 listBlobAssetIds 圈死在 img_ / b_ 前缀内，
//      外族 id 一根毛都不能少；
//   2. 基础三件：老孤儿删 / 被引用留（表行引用 + localStorage 引用）/ 新鲜留；
//   3. 安全阀：引用面枚举抛错 → 整轮放弃（aborted），一个不删。
// 引用面清单见 utils/blobGc.ts 文件头。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tinyBlob = () => new Blob(['x'], { type: 'application/octet-stream' });

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

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

beforeEach(async () => {
    // 每条用例都从干净的世界出发：blob 库、本组会写的引用面表、localStorage 全清，
    // 避免上一条用例的令牌 / 引用串味（GC 是全库扫描，残留会直接改变 deleted/kept 计数）
    for (const s of ['blob_assets', 'characters', 'songs']) {
        await clearStore(s);
    }
    localStorage.clear();
});

describe('混用表守卫（GC 的世界观边界）', () => {
    it('只删 blobRef 命名空间的孤儿；同表混居的外族 id 与被引用令牌一根毛都不少', async () => {
        // 三个外族假行：VRM 模型 / Live2D 运行时缓存 / 遗留陪伴语音（与 blobRef 同表混居）
        await DB.putBlobAsset('video-avatar-1234-5678', tinyBlob());
        await DB.putBlobAsset('x:live2d-runtime-store-v1', tinyBlob());
        await DB.putBlobAsset('companion-startup-voice:y', tinyBlob());
        // 一个无引用的老孤儿（img_ 存量前缀，id 里没有时间戳 → GC 按「老」处理）
        await DB.putBlobAsset('img_orphan_dead', tinyBlob());
        // 一个被引用的老令牌：引用写在 characters 表的行里（引用面之一）
        await DB.putBlobAsset('img_alive_ref', tinyBlob());
        await seedStore('characters', [{ id: 'c1', name: '守卫用角色', avatar: 'blobref:img_alive_ref' }]);

        const result = await runBlobGc({ minAgeMs: 0 });

        expect(result.aborted).toBe(false);
        expect(result.deleted).toBe(1); // 仅那个孤儿
        expect(await DB.getBlobAsset('img_orphan_dead')).toBeNull();
        // kept 只数 img_ / b_ 命名空间：外族 id 根本不在 GC 的世界观里（连 kept 都不计）
        expect(result.kept).toBe(1);
        // 三个外族 id 与被引用 id 全部健在
        expect(await DB.getBlobAsset('video-avatar-1234-5678')).not.toBeNull();
        expect(await DB.getBlobAsset('x:live2d-runtime-store-v1')).not.toBeNull();
        expect(await DB.getBlobAsset('companion-startup-voice:y')).not.toBeNull();
        expect(await DB.getBlobAsset('img_alive_ref')).not.toBeNull();
    });
});

describe('GC 基础三件', () => {
    it('老孤儿删：img_ 前缀、无任何引用 → 被回收', async () => {
        await DB.putBlobAsset('img_orphan_dead', tinyBlob());

        const result = await runBlobGc({ minAgeMs: 0 });

        expect(result).toMatchObject({ deleted: 1, aborted: false });
        expect(await DB.getBlobAsset('img_orphan_dead')).toBeNull();
    });

    it('被引用留：songs 表行里的令牌引用足以保住 Blob', async () => {
        await DB.putBlobAsset('img_song_cover_ref', tinyBlob());
        await seedStore('songs', [{ id: 's1', title: '封面歌', coverImage: 'blobref:img_song_cover_ref' }]);

        const result = await runBlobGc({ minAgeMs: 0 });

        expect(result).toMatchObject({ deleted: 0, aborted: false });
        expect(await DB.getBlobAsset('img_song_cover_ref')).not.toBeNull();
    });

    it('被引用留：localStorage 值里的令牌引用足以保住 Blob', async () => {
        await DB.putBlobAsset('img_ls_backup_ref', tinyBlob());
        localStorage.setItem('acnh_wallpaper_backup', 'blobref:img_ls_backup_ref');

        const result = await runBlobGc({ minAgeMs: 0 });

        expect(result).toMatchObject({ deleted: 0, aborted: false });
        expect(await DB.getBlobAsset('img_ls_backup_ref')).not.toBeNull();
    });

    it('新鲜留：刚 put 的 b_ 令牌即使无引用，默认 72h 豁免窗口内不删', async () => {
        // 真实链路生成新令牌（b_ 前缀内嵌创建时间），故意不落任何引用——
        // 模拟「已 put、引用还没写进持久化面」的竞态窗口
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));

        const result = await runBlobGc(); // 不传 minAgeMs：走默认 72h

        expect(result).toMatchObject({ deleted: 0, aborted: false });
        expect(await getBlobForRef(token)).not.toBeNull();
    });
});

describe('引用面清单拼写守卫', () => {
    it('REF_SOURCE_STORES 里的每个名字都必须是真实存在的 object store', async () => {
        // 名字写错时 getStoreRowsPage 的 contains 兜底会静默返回空页——那个面等于没扫、
        // 无任何报错，面上独占引用的图会被当孤儿删掉。这里把拼写与真实 schema 钉死。
        const db = await openDB();
        const existing = Array.from(db.objectStoreNames);
        for (const name of REF_SOURCE_STORES) {
            expect(existing).toContain(name);
        }
    });
});

describe('安全阀', () => {
    it('引用面枚举抛错 → aborted:true 且一个不删', async () => {
        await DB.putBlobAsset('img_orphan_dead', tinyBlob());
        // 把表面枚举搞坏（走 runBlobGc 的真实链路，而非直接对 blobStore.gc 造假源）
        const spy = vi.spyOn(DB, 'getStoreRowsPage').mockRejectedValue(new Error('枚举炸了'));
        try {
            const result = await runBlobGc({ minAgeMs: 0 });
            expect(result.aborted).toBe(true);
            expect(result.deleted).toBe(0);
            // 出错时孤儿也必须原地不动——宁可留孤儿，绝不在信息不全时删图
            expect(await DB.getBlobAsset('img_orphan_dead')).not.toBeNull();
        } finally {
            spy.mockRestore();
        }
    });
});
