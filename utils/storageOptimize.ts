// 「优化资源存储」：一个按钮还三笔存储上的债。
//
//   一、把已接入令牌链路的面里仍以 base64（data:image）落库的存量图片，批量转成
//       blobref 令牌 + Blob 二进制（省掉 base64 的 ~33% 膨胀）。
//   二、把「同一张图在库里存了好几份 Blob」收敛成一份。
//   三、把还停留在 number[] 形态的记忆向量压成 Float32 原始字节（每维 ~20 字节 → 4 字节）。
//
// 第一笔债的由来：这些面平时靠惰性迁移——哪个消费点读到 data: 才顺手转（加载壁纸、
// 进小屋……），从不打开的内容会一直躺着多占空间；导入 v2 老备份也会重新带进一批 base64。
//
// 第二笔债的由来：同一张图有好几条互不相识的迁移入口，各转各的，于是令牌不同、内容
// 逐字节相同。SDK 的 scanContent 按内容哈希找出这些重复组，utils/blobDedupe.ts 把重复
// 令牌在全部引用面上改写成组内保留的那个。合并只改引用、不删 Blob——失去引用的那几份
// 变成孤儿，交给孤儿 GC 收（删除不可逆，走那条带安全阀的老路更稳）。
//
// 前两笔债咬合在一起：扫库结果会先给 blobRef 的内容记忆预热，所以第一步转换时遇到「库里
// 已经有一份同样内容」的图，直接复用那个令牌，不会又存出一份新的重复来。
//
// 第三笔债的由来：向量的紧凑形态（Uint8Array）和读出口（ensureFloat32）早就到位，靠的却是
// 「谁被搜到谁才转」的惰性迁移 + 一次开机后台扫描；后者跑在页面加载后台、失败只 console.warn，
// 从外面完全看不出来它有没有跑完。这里把同一个扫描挂到手动按钮上，并把失败原样报到界面——
// 一次没转完，下次再点就是了（幂等）。压缩是无损的：读出口两种形态都认，召回质量不受影响。
//
// 跑过一遍后再跑就是 no-op（幂等），导入过旧备份后可以再跑。
//
// 九个面都是按主键分页读的，一次只有一批行在内存里。别改回整表读：真实库里这几张表
// 加起来能有几十 MB（光 messages 一张就两万多行、20 MB 量级），光是把它们读进来就够呛，
// 何况全程还得占着。
//
// ─── 覆盖面即安全边界（本文件的生死线）───
// 只允许收录「当前写入路径已产出令牌」的字段——写令牌意味着读端全链路认令牌，
// 换成令牌不可能破图。逐面对应的现役令牌写入点：
//   assets 'wallpaper' / 'lock_wallpaper' / 'wallpaper_user_backup' ← 壁纸加载器（OSContext）
//   assets 'icon_*'                  ← AppIconEditor
//   assets 'appearance_preset_*'     ← migrateAppearancePresetBlobRefs（字段清单复用同一函数）
//   assets 'room_custom_assets_list' ← RoomApp 自定义素材
//   characters avatar                ← 角色资料页的头像上传（apps/Character.tsx）
//   characters roomConfig.wallImage / floorImage / items[].image ← RoomApp
//   songs coverImage                 ← SongwritingApp
//   cc_custom_parts src / shadowSrc  ← creatorPartToBlobRefs（字段清单复用同一函数）
//   gallery url                      ← Chat 把用户发的图存进相册时
//   themes user/ai 各自的 backgroundImage / decoration / avatarDecoration ← 气泡工坊（ThemeMaker）
//   messages content（只限 type 为 image / emoji 的行）← Chat / GroupChat 发图与发表情时
//   emojis url                       ← Chat 表情导入（http 外链不是本机资源，不转）
//   user_profile avatar / perCharAvatars ← 个人档案的头像上传 / 分角色聊天头像
// 明确不碰：
//   · 社交/手账自己的配图——写入路径还是 base64，读端不认令牌，
//     转了就破图（待逐面迁移后再收录）；
//   · 帖子 / 群 / 角色分组 / 剧场面具 / 银行 / 攻略本 / 生活模拟这 7 张表里的**头像副本**
//     （authorAvatar、群 avatar、卡片上的 charAvatar…）——读端已经认令牌，转了不会破图，
//     只是不值得专门写七段迁移：写端已经产出令牌，用户下次发帖 / 改群资料 / 存卡片时副本
//     自然就是令牌了，存量那几份留着 base64 无非是没省下来。而且这 7 张表都在
//     utils/blobGc.ts 的引用面清单里，头像转出来的 Blob 不会因为副本还是 base64 被当孤儿删。
//   · sprites.chibi / vrState.chibi / companionAvatar / videoCallBackground 等——令牌原生，
//     没有 base64 存量；chibiStudio.like520.img——刻意保持 dataURL（见 docs/chibi-studio.md）。
// 新面收录时除了加进上面清单，还必须确认该面已在 utils/blobGc.ts 的引用面清单里——
// 否则转出来的 Blob 会被孤儿 GC 删掉（storageOptimize.test.ts 有守卫钉这条包含关系）。
//
// 与孤儿 GC 共用 maintenanceLock 互斥：迁移是「引用搬家」，不能撞上进行中的 mark。

import { DB } from './db';
import {
    isBlobRef, dataUrlToBlob, putImageBlobDeduped, getBlobForRef, migrateAppearancePresetBlobRefs,
    primeContentMemo,
} from './blobRef';
import { blobStore } from './blobStore';
import { collectUnmergeableRefs, buildMergePlan, rewriteBlobRefs } from './blobDedupe';
import { creatorPartToBlobRefs } from './creatorPartsBlob';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock, currentMaintenanceHolder } from './maintenanceLock';
import type { AppearancePreset, ChatTheme, CharacterProfile, CustomCreatorPart, Emoji, GalleryImage, Message, SongSheet } from '../types';

/** 本工具会写的表。守卫测试断言它 ⊆ blobGc 的 REF_SOURCE_STORES（转出的 Blob 必须在 GC 视野内）。 */
export const OPTIMIZE_TARGET_STORES = ['assets', 'characters', 'songs', 'cc_custom_parts', 'gallery', 'themes', 'messages', 'emojis', 'user_profile'] as const;

/** 值形态是「裸图片字符串」的 assets 行。 */
const PLAIN_ASSET_IDS = new Set(['wallpaper', 'lock_wallpaper', 'wallpaper_user_backup']);

/** 每批读多少行。跟 utils/blobGc.ts 一个口径：批间事务各自独立，内存峰值只有一批。 */
const PAGE_SIZE = 200;

/**
 * 按主键升序把一张表逐行吐出来，内存里一次只留一批
 * （见 DB.getStoreRowsPage：IDB 事务撑不过 await 挂起，只能每批开一个新的 readonly 事务）。
 *
 * 边读边写为什么不重不漏：翻页靠主键推进，下一页从上一页最后那个键之后开始；而这几面的迁移
 * 只改行里的图片字段，主键一个都不动——改完的行还待在它原来的位置上，翻过去的不会再回来，
 * 没翻到的也不会挪到身后去。
 * 反过来说，谁要是在这个循环里换主键（删掉旧行、用新 id 重写一条）或者往表里插新行，这条保证
 * 就没了：落在游标前面的再也扫不到，落在后面的会被当成新行又处理一遍。真要删行 / 加行，
 * 请另起一趟遍历，别混进来。
 */
async function* iterateStoreRows<T>(storeName: string): AsyncGenerator<T> {
    let afterKey: IDBValidKey | null = null;
    for (;;) {
        const { rows, lastKey } = await DB.getStoreRowsPage(storeName, afterKey, PAGE_SIZE);
        for (const row of rows) yield row as T;
        if (lastKey === null || rows.length < PAGE_SIZE) break;
        afterKey = lastKey;
    }
}

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
    /** 合并掉的重复 Blob 份数（同一张图多存的那几份） */
    mergedDuplicates: number;
    /** 合并后能被孤儿清理回收的字节数 */
    reclaimableBytes: number;
    /** 触到「换图即删」的字段、不敢合并而跳过的重复组数（见 blobDedupe 的清单） */
    skippedGroups: number;
    /** 扫库没做成（keys 读不出 / 没有 crypto.subtle），这一轮没有去重 */
    scanUnavailable: boolean;
    /** 压成紧凑形态的记忆向量条数 */
    vectorsCompacted: number;
    /** 向量压缩失败的原因；null = 这轮没出问题。开机那次是静默 warn 的，这里必须报出来 */
    vectorError: string | null;
}

export async function optimizeResourceStorage(
    onProgress?: (p: OptimizeProgress) => void,
): Promise<OptimizeResult> {
    if (!tryAcquireMaintenanceLock('优化资源存储')) {
        throw new Error(`另一项存储维护（${currentMaintenanceHolder()}）正在进行，请稍后再试。`);
    }
    try {
        const result: OptimizeResult = {
            converted: 0, uniqueBlobs: 0, bytesBefore: 0, bytesAfter: 0, failed: 0,
            mergedDuplicates: 0, reclaimableBytes: 0, skippedGroups: 0, scanUnavailable: false,
            vectorsCompacted: 0, vectorError: null,
        };
        // 已计过字节数的令牌：canonical 迁移函数产出的令牌经这里补记大小，避免重复计。
        const countedTokens = new Set<string>();

        /** data:image → 令牌；非图片 data / 已是令牌 / http 一律返回 null（调用方不动原值）。
         *
         *  「同一份图别转两遍」这件事交给 putImageBlobDeduped——它按内容哈希认人，记的是
         *  哈希（几十字节），不是 base64 原文。这里不要再套一层以 data URL 为键的缓存：
         *  那层缓存等于把这一轮见过的每张图的原文都钉在内存里，表分页读了也白读。 */
        const convert = async (value: unknown): Promise<string | null> => {
            if (typeof value !== 'string' || !value.startsWith('data:image/')) return null;
            try {
                const blob = dataUrlToBlob(value);
                // 复用命中时不计新建：那份 Blob 本来就在库里占着，这次一个字节都没多存
                const { token, reused } = await putImageBlobDeduped(blob);
                result.converted++;
                result.bytesBefore += value.length;
                if (!reused && !countedTokens.has(token)) {
                    countedTokens.add(token);
                    result.uniqueBlobs++;
                    result.bytesAfter += blob.size;
                }
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

        // ── 0) 扫库：谁和谁装的是同一份内容 ───────────────────────
        // 结果有两个用处：给内容记忆预热（下面转换时直接复用库里已有的那份），
        // 以及收尾时把存量重复合并掉。扫不动就整轮跳过去重，转换照跑。
        const scan = await blobStore.scanContent({
            onProgress: (done, total) => onProgress?.({ label: '查找重复图片', done, total }),
        });
        // 每条都算不出哈希（非安全上下文没有 crypto.subtle）和「真没重复」长得一模一样，
        // 这里一并当作「这轮没做成去重」报出去，别让它静默过去。
        result.scanUnavailable = scan.aborted || (scan.scanned > 0 && scan.skipped === scan.scanned);

        // 被「换图即删」的字段引用着的令牌不能拿来共享：对方一删，这边就破图。
        const unmergeable = result.scanUnavailable ? new Set<string>() : await collectUnmergeableRefs();
        if (!result.scanUnavailable) {
            const safeByHash = new Map<string, string[]>();
            for (const [hash, tokens] of scan.byHash) {
                const safe = tokens.filter(t => !unmergeable.has(t));
                if (safe.length > 0) safeByHash.set(hash, safe);
            }
            primeContentMemo(safeByHash);
        }

        // ── 进度条的总数：九张表各数一下行数 ─────────────────────
        // 只要个数字，count() 不读行里的内容，几十 MB 的图不会被顺带读进内存。
        let total = 0;
        for (const storeName of OPTIMIZE_TARGET_STORES) total += await DB.countStoreRows(storeName);
        let done = 0;
        // total 是开跑那一刻的快照。跑的中途别处往这几张表写了行，实际走过的行数就跟它对不上：
        // 多出来的行照样处理，只是报出去的 done 按 total 封顶——done 只增不减也不越过 total，
        // 进度条既不会倒退也不会冲过头；行变少时它停在不满格的位置，函数返回即收尾
        // （展示侧本来就以返回为准，不靠进度条判完成）。
        const tick = (label: string) => { done++; onProgress?.({ label, done: Math.min(done, total), total }); };

        // ── 1) assets 表 ─────────────────────────────────────────
        for await (const a of iterateStoreRows<{ id: string; data: string }>('assets')) {
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
                const migrated = await migrateAppearancePresetBlobRefs(preset);
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

        // ── 2) characters：角色头像 + 小屋图 ──────────────────────
        // 两样东西在同一趟遍历里一起转。别拆成两趟：翻页靠主键推进，多一趟就是把整张表
        // 连同行里那些几 MB 的图再读一遍（见 iterateStoreRows 的注释）。
        for await (const c of iterateStoreRows<CharacterProfile>('characters')) {
            tick('角色头像与小屋');
            let changed = false;
            // 头像是两用字段：可能是图，也可能是个 emoji，还可能是 http 外链或已经是令牌。
            // convert 只认 data:image/ 开头的值，其余一律原样不动。
            const avatarToken = await convert(c.avatar);
            if (avatarToken) { c.avatar = avatarToken; changed = true; }
            const rc = (c as any).roomConfig;
            if (rc) {
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
            }
            if (changed) { await DB.saveCharacter(c); await yieldMain(); }
        }

        // ── 3) songs 封面 ─────────────────────────────────────────
        for await (const s of iterateStoreRows<SongSheet>('songs')) {
            tick('歌曲封面');
            const token = await convert((s as any).coverImage);
            if (token) { (s as any).coverImage = token; await DB.saveSong(s); await yieldMain(); }
        }

        // ── 4) 捏人器自定义部件 ───────────────────────────────────
        for await (const p of iterateStoreRows<CustomCreatorPart>('cc_custom_parts')) {
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

        // ── 5) 相册 ───────────────────────────────────────────────
        // 聊天里发的每张图都会存一份进来，是最容易堆大的一面。
        for await (const g of iterateStoreRows<GalleryImage>('gallery')) {
            tick('相册');
            const token = await convert(g.url);
            if (token) { g.url = token; await DB.saveGalleryImage(g); await yieldMain(); }
        }

        // ── 6) 聊天气泡主题 ───────────────────────────────────────
        // 一套主题分用户侧和角色侧，每侧各带底纹、气泡贴纸、头像挂件三张图，最多 6 张。
        // 两侧字段名一样，所以两层循环走同一份清单；漏掉一侧是这一面最容易犯的错。
        for await (const t of iterateStoreRows<ChatTheme>('themes')) {
            tick('气泡主题');
            let changed = false;
            for (const side of ['user', 'ai'] as const) {
                const style = t[side];
                if (!style) continue;
                for (const key of ['backgroundImage', 'decoration', 'avatarDecoration'] as const) {
                    const token = await convert(style[key]);
                    if (token) { style[key] = token; changed = true; }
                }
            }
            if (changed) { await DB.saveTheme(t); await yieldMain(); }
        }

        // ── 7) 聊天图与表情消息 ───────────────────────────────────
        // 全库最大的一张表（两万多行、20 MB 量级），也是唯一一张「绝大多数行跟图片无关」的：
        // 只有 type 为 image / emoji 的行，content 里躺的才是图片。别的类型（文本、各种卡片
        // 的 JSON、转账…）一个字节都不许动——先按 type 卡一道，再交给只吃 data:image/ 的
        // convert，两道一起挡住「正文恰好长得像 data URL 的文本消息」。
        // 转出来的令牌可能跟相册那一面是同一个（同一张图发出去时两边各存了一份引用），
        // 这正是要的效果：一份 Blob 两处引用，删其中一处也绝不能直接删 Blob。
        for await (const m of iterateStoreRows<Message>('messages')) {
            tick('聊天图片');
            if (m.type !== 'image' && m.type !== 'emoji') continue;
            const token = await convert(m.content);
            if (token) { await DB.updateMessage(m.id, token); await yieldMain(); }
        }

        // ── 8) 表情库 ─────────────────────────────────────────────
        // url 有两种：用户上传的图（data:）和加进来的网络表情（http 外链）。外链是别人
        // 服务器上的地址，本机没有它的二进制，转不了也不用转——convert 只认 data:image/
        // 开头的值，外链天然落在判定之外。
        for await (const e of iterateStoreRows<Emoji>('emojis')) {
            tick('表情包');
            const token = await convert(e.url);
            if (token) { await DB.saveEmoji(e.name, token, e.categoryId); await yieldMain(); }
        }

        // ── 9) 我方头像（user_profile 单例）───────────────────────
        // 两处都要转：整体头像 avatar，和「分角色聊天头像」perCharAvatars（charId → 头像的
        // 对象，逐个值转）。只转 avatar 是这一面最容易犯的错——分角色那几张会静默留在 base64。
        // 写回用通用整行写回而不是 DB.saveUserProfile：后者会把主键强行按成 'me'，而这个
        // 循环的不重不漏建立在「主键一个都不动」上（见 iterateStoreRows 的注释）。
        for await (const p of iterateStoreRows<any>('user_profile')) {
            tick('我的头像');
            let changed = false;
            const avatarToken = await convert(p?.avatar);
            if (avatarToken) { p.avatar = avatarToken; changed = true; }
            const perChar = p?.perCharAvatars;
            if (perChar && typeof perChar === 'object') {
                for (const charId of Object.keys(perChar)) {
                    const token = await convert(perChar[charId]);
                    if (token) { perChar[charId] = token; changed = true; }
                }
            }
            if (changed) { await DB.putStoreRows('user_profile', [p]); await yieldMain(); }
        }

        // ── 10) 合并存量重复：把重复令牌在全部引用面上改写成保留的那个 ──
        // 只改引用，不删 Blob。失去引用的那几份变成孤儿，由孤儿清理回收。
        if (!result.scanUnavailable && scan.duplicateGroups.length > 0) {
            const plan = buildMergePlan(scan.duplicateGroups, unmergeable);
            result.skippedGroups = plan.skippedGroups;
            if (plan.mapping.size > 0) {
                const rewrite = await rewriteBlobRefs(plan.mapping, {
                    onProgress: scanned => onProgress?.({ label: '合并重复图片', done: scanned, total: scanned }),
                });
                // 按「真改掉的那些」记账，不按计划数。上一轮合并留下的孤儿 Blob 还躺在库里，
                // 这一轮扫描照样把它当重复报出来，按计划数就会虚报一笔并不存在的收益。
                result.mergedDuplicates = rewrite.mergedRefs.size;
                for (const ref of rewrite.mergedRefs) {
                    result.reclaimableBytes += plan.bytesByToken.get(ref) ?? 0;
                }
            }
        }

        // ── 11) 记忆向量压成紧凑形态 ──────────────────────────────
        // 跟图片没有任何关系，单独一个 try：图片那几步的成果不该因为向量失败就报不出来。
        // 反过来也不吞错——开机那次后台扫描正是因为只 console.warn，卡住了也没人知道。
        try {
            const { MemoryVectorDB } = await import('./memoryPalace/db');
            result.vectorsCompacted = await MemoryVectorDB.scanAndMigrateLegacy((migrated, scanned) => {
                onProgress?.({ label: '压缩记忆向量', done: migrated, total: Math.max(scanned, migrated) });
            });
        } catch (e) {
            result.vectorError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
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
