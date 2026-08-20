// 「优化资源存储」：把已接入令牌链路的面里仍以 base64（data:image）落库的存量图片，
// 一次性批量转成 blobref 令牌 + Blob 二进制（省掉 base64 的 ~33% 膨胀）。
//
// 这些面平时靠惰性迁移——哪个消费点读到 data: 才顺手转（加载壁纸、进小屋……），
// 从不打开的内容会一直躺着多占空间；导入 v2 老备份也会重新带进一批 base64。
// 这里把债一次还清，跑过一遍后再跑就是 no-op（幂等），导入过旧备份后可以再跑。
//
// ─── 覆盖面即安全边界（本文件的生死线）───
// 只允许收录「当前写入路径已产出令牌」的字段——写令牌意味着读端全链路认令牌，
// 换成令牌不可能破图。逐面对应的现役令牌写入点：
//   assets 'wallpaper' / 'lock_wallpaper' / 'wallpaper_user_backup' ← 壁纸加载器（OSContext）
//   assets 'icon_*'                  ← AppIconEditor
//   assets 'appearance_preset_*'     ← migrateAppearancePresetBlobRefs（字段清单复用同一函数）
//   assets 'room_custom_assets_list' ← RoomApp 自定义素材
//   characters roomConfig.wallImage / floorImage / items[].image ← RoomApp
//   songs coverImage                 ← SongwritingApp
//   cc_custom_parts src / shadowSrc  ← creatorPartToBlobRefs（字段清单复用同一函数）
// 明确不碰：
//   · 角色 avatar、聊天图、相册、表情包、社交/手账——写入路径还是 base64，读端不认令牌，
//     转了就破图（待逐面迁移后再收录）；
//   · sprites.chibi / vrState.chibi / companionAvatar / videoCallBackground 等——令牌原生，
//     没有 base64 存量；chibiStudio.like520.img——刻意保持 dataURL（见 docs/chibi-studio.md）。
// 新面收录时除了加进上面清单，还必须确认该面已在 utils/blobGc.ts 的引用面清单里——
// 否则转出来的 Blob 会被孤儿 GC 删掉（storageOptimize.test.ts 有守卫钉这条包含关系）。
//
// 与孤儿 GC 共用 maintenanceLock 互斥：迁移是「引用搬家」，不能撞上进行中的 mark。

import { DB } from './db';
import {
    isBlobRef, dataUrlToBlob, putImageBlob, getBlobForRef, migrateAppearancePresetBlobRefs,
} from './blobRef';
import { creatorPartToBlobRefs } from './creatorPartsBlob';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock, currentMaintenanceHolder } from './maintenanceLock';
import type { AppearancePreset, CustomCreatorPart } from '../types';

/** 本工具会写的表。守卫测试断言它 ⊆ blobGc 的 REF_SOURCE_STORES（转出的 Blob 必须在 GC 视野内）。 */
export const OPTIMIZE_TARGET_STORES = ['assets', 'characters', 'songs', 'cc_custom_parts'] as const;

/** 值形态是「裸图片字符串」的 assets 行。 */
const PLAIN_ASSET_IDS = new Set(['wallpaper', 'lock_wallpaper', 'wallpaper_user_backup']);

export interface OptimizeProgress {
    /** 正在处理的面（给进度条文案用） */
    label: string;
    done: number;
    total: number;
}

export interface OptimizeResult {
    /** 被替换成令牌的字段数（同图多处引用各计一次） */
    converted: number;
    /** 实际新建的 Blob 数（去重后） */
    uniqueBlobs: number;
    /** 被替换掉的 data: 字符串总长度（≈原来占的字节） */
    bytesBefore: number;
    /** 对应 Blob 的总字节数（去重后） */
    bytesAfter: number;
    /** 转换失败、原值保留的字段数（图不丢，只是这张没省下来） */
    failed: number;
}

export async function optimizeResourceStorage(
    onProgress?: (p: OptimizeProgress) => void,
): Promise<OptimizeResult> {
    if (!tryAcquireMaintenanceLock('优化资源存储')) {
        throw new Error(`另一项存储维护（${currentMaintenanceHolder()}）正在进行，请稍后再试。`);
    }
    try {
        const result: OptimizeResult = { converted: 0, uniqueBlobs: 0, bytesBefore: 0, bytesAfter: 0, failed: 0 };
        // 同一份 base64 全局只建一个 Blob。与 migrateAppearancePresetBlobRefs 共用
        // （它的 cache 契约就是 dataUrl → 已存值）。
        const cache = new Map<string, string>();
        // 已计过字节数的令牌：canonical 迁移函数产出的令牌经这里补记大小，避免重复计。
        const countedTokens = new Set<string>();

        /** data:image → 令牌；非图片 data / 已是令牌 / http 一律返回 null（调用方不动原值）。 */
        const convert = async (value: unknown): Promise<string | null> => {
            if (typeof value !== 'string' || !value.startsWith('data:image/')) return null;
            const hit = cache.get(value);
            if (hit) {
                result.converted++;
                result.bytesBefore += value.length;
                return hit;
            }
            try {
                const blob = dataUrlToBlob(value);
                const token = await putImageBlob(blob);
                cache.set(value, token);
                countedTokens.add(token);
                result.converted++;
                result.uniqueBlobs++;
                result.bytesBefore += value.length;
                result.bytesAfter += blob.size;
                return token;
            } catch {
                result.failed++; // 坏 data: 转不动：原值保留，图不丢
                return null;
            }
        };

        /** canonical 迁移函数（预设 / 捏人器部件）转完后的记账：按 before/after 差异补计。 */
        const tallyPair = async (before: unknown, after: unknown): Promise<void> => {
            if (typeof before !== 'string' || !before.startsWith('data:image/')) return;
            if (typeof after !== 'string' || !isBlobRef(after)) return;
            result.converted++;
            result.bytesBefore += before.length;
            if (!countedTokens.has(after)) {
                countedTokens.add(after);
                result.uniqueBlobs++;
                const blob = await getBlobForRef(after);
                if (blob) result.bytesAfter += blob.size;
            }
        };

        const yieldMain = () => new Promise<void>(r => setTimeout(r, 0));

        // ── 1) assets 表 ─────────────────────────────────────────
        const assets = await DB.getAllAssets();
        // ── 预取其余三面（总数先算齐，进度条不跳） ──
        const characters = await DB.getAllCharacters();
        const songs = await DB.getAllSongs();
        const parts = await DB.getCustomCreatorParts();
        const total = assets.length + characters.length + songs.length + parts.length;
        let done = 0;
        const tick = (label: string) => { done++; onProgress?.({ label, done, total }); };

        for (const a of assets) {
            tick('系统外观');
            if (typeof a.data !== 'string') continue;
            if (PLAIN_ASSET_IDS.has(a.id) || a.id.startsWith('icon_')) {
                const token = await convert(a.data);
                if (token) { await DB.saveAsset(a.id, token); await yieldMain(); }
            } else if (a.id.startsWith('appearance_preset_')) {
                let preset: AppearancePreset;
                try { preset = JSON.parse(a.data); } catch { continue; }
                if (!preset || typeof preset !== 'object' || !preset.theme) continue;
                const beforeFields = presetImageFields(preset);
                const migrated = await migrateAppearancePresetBlobRefs(preset, cache);
                const afterFields = presetImageFields(migrated);
                let changed = false;
                for (let i = 0; i < beforeFields.length; i++) {
                    if (beforeFields[i] !== afterFields[i]) { changed = true; await tallyPair(beforeFields[i], afterFields[i]); }
                }
                if (changed) { await DB.saveAsset(a.id, JSON.stringify(migrated)); await yieldMain(); }
            } else if (a.id === 'room_custom_assets_list') {
                let list: Array<{ image?: string }>;
                try { list = JSON.parse(a.data); } catch { continue; }
                if (!Array.isArray(list)) continue;
                let changed = false;
                for (const entry of list) {
                    const token = await convert(entry?.image);
                    if (token) { entry.image = token; changed = true; }
                }
                if (changed) { await DB.saveAsset(a.id, JSON.stringify(list)); await yieldMain(); }
            }
        }

        // ── 2) characters 的小屋图 ────────────────────────────────
        for (const c of characters) {
            tick('小屋');
            const rc = (c as any).roomConfig;
            if (!rc) continue;
            let changed = false;
            for (const key of ['wallImage', 'floorImage']) {
                const token = await convert(rc[key]);
                if (token) { rc[key] = token; changed = true; }
            }
            if (Array.isArray(rc.items)) {
                for (const item of rc.items) {
                    const token = await convert(item?.image);
                    if (token) { item.image = token; changed = true; }
                }
            }
            if (changed) { await DB.saveCharacter(c); await yieldMain(); }
        }

        // ── 3) songs 封面 ─────────────────────────────────────────
        for (const s of songs) {
            tick('歌曲封面');
            const token = await convert((s as any).coverImage);
            if (token) { (s as any).coverImage = token; await DB.saveSong(s); await yieldMain(); }
        }

        // ── 4) 捏人器自定义部件 ───────────────────────────────────
        for (const p of parts) {
            tick('捏人器部件');
            const srcIsData = typeof p.src === 'string' && p.src.startsWith('data:');
            const shadowIsData = typeof p.shadowSrc === 'string' && p.shadowSrc.startsWith('data:');
            if (!srcIsData && !shadowIsData) continue;
            const migrated: CustomCreatorPart = await creatorPartToBlobRefs(p);
            if (migrated.src === p.src && migrated.shadowSrc === p.shadowSrc) continue;
            await tallyPair(p.src, migrated.src);
            await tallyPair(p.shadowSrc, migrated.shadowSrc);
            await DB.saveCustomCreatorPart(migrated);
            await yieldMain();
        }

        return result;
    } finally {
        releaseMaintenanceLock();
    }
}

/** 外观预设里参与令牌迁移的图片字段快照（顺序稳定，before/after 逐位对比用）。
 *  字段范围由 migrateAppearancePresetBlobRefs 决定，这里只是读它动过的位置。 */
function presetImageFields(preset: AppearancePreset): Array<string | undefined> {
    const icons = preset.customIcons || {};
    return [
        preset.theme?.wallpaper,
        (preset.theme as any)?.lockWallpaper,
        ...Object.keys(icons).sort().map(k => icons[k]),
    ];
}
