/**
 * 存储优化「测试反馈」诊断器（临时功能，小规模测试结束后整块撤掉）
 *
 * 招募的测试者装上这一版，在设置页点一个按钮，就能把「优化前库里长什么样 → 优化跑得
 * 怎么样 → 优化后长什么样」整个过程记下来，存进 localStorage 并导出成一个 JSON 文件
 * 发回来。测试收尾后本文件连同它的 UI 会一起 revert，所以别让别的功能依赖它。
 *
 * ─── 两条红线 ───
 * 一、**跑的必须是同一个优化**。中间那一步直接调 utils/storageOptimize.ts 的
 *     optimizeResourceStorage()，跟设置页那个按钮一字不差——绝不能为了「方便观察」
 *     在这儿另写一份迁移，否则测出来的是诊断专用路径，跟用户真会跑的那条无关。
 * 二、**报告里不许有用户的内容**。扫描只记「哪张表的哪条字段路径上有几张 base64、
 *     多少字节、什么 MIME」，从不留字符串原文；localStorage 只记键名和长度，值一个字
 *     都不记；捕获到的报错先过一道脱敏（data URL 正文换成长度、整条疑似含密钥的直接丢）。
 *
 * ─── 路径是「扫出来的」，不是写死的 ───
 * 扫描不维护字段清单，而是把主库每张表的每一行整个递归走一遍：遇到字符串就按形态归类
 * （data:image / blobref 令牌 / http 外链 / 其他 data URL），路径由递归过程自己拼。
 * 这样不存在「清单漏了一个面 → 那个面静默不统计」的失败模式——只要行里真有 base64，
 * 它必然落在某条路径上。代价是 messages 这种大表要整表走一遍，所以分页读、批间让主线程。
 *
 * 另外两个容易漏掉的面也一并扫了：assets 里那些「值本身是一段 JSON」的行
 * （appearance_preset_* / room_custom_assets_list / ls_mirror_v1）会被二次解析后钻进去；
 * localStorage 全量按键扫一遍。两者都是令牌的正经引用面（见 utils/blobGc.ts 的清单），
 * 不扫的话孤儿数会虚高。
 */

import { DB, openDB } from './db';
import { isBlobRef, BLOBREF_PREFIX } from './blobRef';
import { optimizeResourceStorage, type OptimizeProgress, type OptimizeResult } from './storageOptimize';
import {
    readStorageOverview, computeStorageBreakdown, formatBytes,
    type StorageOverview, type StorageBreakdown,
} from './storageStats';
import { APP_VERSION, BUILD_LABEL, BUILD_TIME_LABEL } from './buildInfo';

// ─── 扫描：一行一行走，路径自己长出来 ────────────────────────────

/** 一条字段路径上的统计。路径形如 `roomConfig.items[].image`、`[appearance_preset_*].data(json).theme.wallpaper`。 */
export interface FieldStat {
    store: string;
    path: string;
    /** 这条路径上出现过多少个值（不分形态，用来判断样本多不多） */
    hits: number;
    /** 整串就是一张内嵌图（data:image/...） */
    base64Count: number;
    base64Bytes: number;
    base64Mimes: Record<string, number>;
    /** 整串是一个 blobref 令牌 */
    blobRefCount: number;
    /** http(s) 外链：本机没有它的二进制，转不了也不用转 */
    httpCount: number;
    /** 非图片的 data URL（音频、字体…） */
    otherDataCount: number;
    otherDataBytes: number;
    /** 藏在长文本里的图 / 令牌（富文本、拼进 JSON 又解不开的串） */
    embeddedBase64Count: number;
    embeddedBase64Bytes: number;
    embeddedRefCount: number;
    /** 直接躺在这条路径上的二进制（Blob / TypedArray） */
    binaryCount: number;
    binaryBytes: number;
    binaryMimes: Record<string, number>;
}

/** 每张表扫了多少行、出没出错。scanned 比 rows 少说明中途被截断了。 */
export interface StoreScanInfo {
    store: string;
    rows: number;
    scanned: number;
    error?: string;
}

/** blob_assets 是混用表：blobref 图片、VRM 模型、Live2D 缓存、陪伴语音都在里面。 */
export interface BlobStoreStat {
    total: number;
    totalBytes: number;
    /** 按 id 前缀分族（图片 / 模型 / 缓存…） */
    byFamily: Record<string, { count: number; bytes: number }>;
    byMime: Record<string, { count: number; bytes: number }>;
    /** 属于 blobref 命名空间（img_ / b_）的那部分 */
    refIdCount: number;
    refIdBytes: number;
    /** 库里有、全库没人引用：等下次孤儿清理才会被回收 */
    orphanCount: number;
    orphanBytes: number;
    /** 有人引用、库里却没有：这是破图，最要紧的一个信号 */
    danglingCount: number;
    danglingSamples: string[];
}

export interface LocalStorageEntryStat {
    /** 归一化后的键名（随机 id 段换成 *）。值一个字都不记。 */
    key: string;
    /** 归一化后合并了几个真实键 */
    keys: number;
    chars: number;
    base64Count: number;
    base64Chars: number;
    blobRefCount: number;
}

export interface LocalStorageStat {
    keyCount: number;
    totalChars: number;
    entries: LocalStorageEntryStat[];
    error?: string;
}

export interface SnapshotTotals {
    base64Count: number;
    base64Bytes: number;
    blobRefCount: number;
    distinctRefs: number;
    httpCount: number;
    otherDataCount: number;
    otherDataBytes: number;
    embeddedBase64Count: number;
    embeddedBase64Bytes: number;
    binaryCount: number;
    binaryBytes: number;
}

export interface StorageSnapshot {
    at: string;
    scanMs: number;
    dbName: string | null;
    dbVersion: number | null;
    /** 浏览器实报的总用量 / 配额 / 持久化状态 */
    overview: StorageOverview | null;
    /** 分类占用（跟设置页「看看都是些什么占的」同一份数据） */
    breakdown: StorageBreakdown | null;
    stores: StoreScanInfo[];
    fields: FieldStat[];
    totals: SnapshotTotals;
    blobs: BlobStoreStat | null;
    localStorage: LocalStorageStat | null;
    /** 递归撞到深度上限的次数；不是 0 说明有超深结构没走完 */
    truncatedPaths: number;
    /** 整轮扫描超时被掐断 */
    timedOut: boolean;
    errors: string[];
}

export interface ScanProgress {
    label: string;
    done: number;
    total: number;
}

/** 每批读多少行。跟 blobGc / storageOptimize 一个口径：批间事务各自独立，内存峰值只有一批。 */
const PAGE_SIZE = 200;
/** 递归深度上限，防某个字段被塞成套娃结构把栈走爆 */
const MAX_DEPTH = 14;
/** 「字符串其实是段 JSON」最多往里钻几层 */
const MAX_JSON_DEPTH = 3;
/** 少于这个数的对象一律按结构体看待，不折叠——两三个 key 不值得赌它是不是张 map */
const OBJECT_KEY_FANOUT_MIN = 4;
/** 短字符串不做「里面是不是嵌着图」的二次检查，省下绝大多数字段的开销 */
const EMBED_SCAN_MIN_LEN = 48;
/** 报告里最多留多少条字段路径，其余合成一条汇总（防止 id 类路径把文件撑爆） */
const MAX_FIELD_ROWS = 400;
/** 扫描途中最多攒多少条路径。撞上限之后新路径一律并进一条兜底，防大库把内存撑爆 */
const MAX_TRACKED_PATHS = 5000;
const OVERFLOW_PATH = '(路径过多，已合并)';
/** localStorage 最多列多少个键 */
const MAX_LS_ROWS = 60;
/** 整轮扫描的墙钟上限：库特别大时宁可截断也不能把用户卡死在设置页。
 *  真实数据校准过：一个 434 MB 的库（memory_links 150 万行、messages 9.6 万行）单次扫描
 *  用了 145 秒——按原先 150 秒的线差 5 秒就会被截断，而截断的报告缺哪几张表并不好看出来。
 *  慢的是行数不是图片，所以放宽到 10 分钟，别把大库用户的报告切一半。 */
const SCAN_TIMEOUT_MS = 600_000;

const EMBEDDED_BASE64_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
const EMBEDDED_REF_RE = /blobref:[A-Za-z0-9_-]+/g;

const MAIN_DB_NAME = 'AetherOS_Data';

interface ScanCtx {
    store: string;
    fields: Map<string, FieldStat>;
    /** 全库引用到的令牌（含 localStorage）。跟 blob_assets 的 id 一比就知道谁是孤儿、谁破图 */
    refs: Set<string>;
    truncatedPaths: number;
}

const makeStat = (store: string, path: string): FieldStat => ({
    store, path, hits: 0,
    base64Count: 0, base64Bytes: 0, base64Mimes: {},
    blobRefCount: 0, httpCount: 0,
    otherDataCount: 0, otherDataBytes: 0,
    embeddedBase64Count: 0, embeddedBase64Bytes: 0, embeddedRefCount: 0,
    binaryCount: 0, binaryBytes: 0, binaryMimes: {},
});

/**
 * 取（或建）某条路径的统计槽。
 *
 * 先按原路径查——已经在册的路径永远认自己那一条，撞没撞上限都一样；只有「要新开一条」
 * 时才看上限，超了就并进兜底那条。反过来写（先判上限再查）会让上限之后所有已有路径
 * 也一起被并走，攒了半天的明细当场作废。
 */
function statFor(ctx: ScanCtx, rawPath: string): FieldStat {
    const key = `${ctx.store} | ${rawPath}`;
    const existing = ctx.fields.get(key);
    if (existing) return existing;

    if (ctx.fields.size >= MAX_TRACKED_PATHS) {
        const overflowKey = `${ctx.store} | ${OVERFLOW_PATH}`;
        let overflow = ctx.fields.get(overflowKey);
        if (!overflow) {
            overflow = makeStat(ctx.store, OVERFLOW_PATH);
            ctx.fields.set(overflowKey, overflow);
        }
        return overflow;
    }

    const stat = makeStat(ctx.store, rawPath);
    ctx.fields.set(key, stat);
    return stat;
}

const bump = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };

/** 这个 key 看着像不像随机生成的 id（charId、时间戳、uuid…）而不是个字段名。 */
function looksLikeRandomKey(key: string): boolean {
    if (key.length >= 24) return true;                       // 长到这个份上基本就是 id
    if (/^\d{4,}$/.test(key)) return true;                   // 纯数字
    if (/[_-]\d{6,}/.test(key)) return true;                 // char_1712345678901 这种
    if (/^[0-9a-f]{8,}$/i.test(key)) return true;            // 十六进制串
    if (/^[a-z]+[_-][a-z0-9]{6,}$/i.test(key)) return true;  // 前缀 + 随机段
    return false;
}

/**
 * 这个对象是「一张 id → 值的表」，还是「一个有名有姓的结构体」？
 *
 * 是表就把路径折叠成 *（perCharAvatars 下面挂着几十个 charId，一个 id 一条路径的话
 * 报告直接被 id 淹掉）。判据只看 key 长得像不像随机 id，**不能只按 key 的个数**——
 * CharacterProfile 顶层轻松十几个字段，按个数折叠会把 avatar、roomConfig.wallImage
 * 这些真正要看的路径全糊成 *，整份报告就废了。
 */
function looksLikeIdMap(keys: string[]): boolean {
    if (keys.length < OBJECT_KEY_FANOUT_MIN) return false;
    const idLike = keys.reduce((n, k) => n + (looksLikeRandomKey(k) ? 1 : 0), 0);
    return idLike / keys.length >= 0.6;
}

/** 从 data URL 头上取 MIME（只看开头一小截，别把整段 base64 拿来 slice）。 */
function dataUrlMime(value: string): string {
    const head = value.slice(5, 64);
    const end = head.search(/[;,]/);
    return (end >= 0 ? head.slice(0, end) : head) || '(未知)';
}

function classifyString(value: string, path: string, ctx: ScanCtx, depth: number, jsonDepth: number): void {
    const stat = statFor(ctx, path);
    stat.hits++;
    if (value.startsWith('data:image/')) {
        stat.base64Count++;
        stat.base64Bytes += value.length;
        bump(stat.base64Mimes, dataUrlMime(value));
        return;
    }
    if (isBlobRef(value)) {
        stat.blobRefCount++;
        ctx.refs.add(value);
        return;
    }
    if (/^https?:\/\//i.test(value)) { stat.httpCount++; return; }
    if (value.startsWith('data:')) {
        stat.otherDataCount++;
        stat.otherDataBytes += value.length;
        return;
    }

    // 剩下的都是普通文本。绝大多数跟图片无关，先用两次 includes 挡掉——只有真含图 / 含令牌的
    // 才值得往下折腾（messages 表两万行卡片 JSON，少了这道闸整轮扫描会慢一个量级）。
    if (value.length < EMBED_SCAN_MIN_LEN) return;
    const hasImage = value.includes('data:image/');
    const hasRef = value.includes(BLOBREF_PREFIX);
    if (!hasImage && !hasRef) return;

    // 值本身是段 JSON（assets 的外观预设 / 小屋素材表 / localStorage 镜像就是这样）：
    // 解开再递归，才能拿到「预设里的哪个字段」这种有用的路径，而不是笼统一条 data。
    if (jsonDepth < MAX_JSON_DEPTH && (value[0] === '{' || value[0] === '[')) {
        try {
            const parsed = JSON.parse(value);
            walkValue(parsed, `${path}(json)`, ctx, depth + 1, jsonDepth + 1);
            return;
        } catch {
            // 不是合法 JSON，落到下面按裸文本数
        }
    }
    if (hasImage) {
        for (const m of value.matchAll(EMBEDDED_BASE64_RE)) {
            stat.embeddedBase64Count++;
            stat.embeddedBase64Bytes += m[0].length;
        }
    }
    if (hasRef) {
        for (const m of value.matchAll(EMBEDDED_REF_RE)) {
            stat.embeddedRefCount++;
            ctx.refs.add(m[0]);
        }
    }
}

function walkValue(value: unknown, path: string, ctx: ScanCtx, depth: number, jsonDepth: number): void {
    if (value === null || value === undefined) return;
    if (depth > MAX_DEPTH) { ctx.truncatedPaths++; return; }

    const type = typeof value;
    if (type === 'string') { classifyString(value as string, path, ctx, depth, jsonDepth); return; }
    if (type !== 'object') return;   // number / boolean / function / symbol 一律不关心

    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        const stat = statFor(ctx, path);
        stat.hits++; stat.binaryCount++; stat.binaryBytes += value.size;
        bump(stat.binaryMimes, value.type || '(空 MIME)');
        return;
    }
    if (value instanceof ArrayBuffer) {
        const stat = statFor(ctx, path);
        stat.hits++; stat.binaryCount++; stat.binaryBytes += value.byteLength;
        bump(stat.binaryMimes, '(ArrayBuffer)');
        return;
    }
    if (ArrayBuffer.isView(value)) {
        const stat = statFor(ctx, path);
        stat.hits++; stat.binaryCount++; stat.binaryBytes += (value as ArrayBufferView).byteLength;
        bump(stat.binaryMimes, `(${(value as object).constructor?.name || 'TypedArray'})`);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) walkValue(item, `${path}[]`, ctx, depth + 1, jsonDepth);
        return;
    }

    const keys = Object.keys(value as Record<string, unknown>);
    const collapse = looksLikeIdMap(keys);
    for (const key of keys) {
        const seg = collapse ? '*' : key;
        walkValue((value as Record<string, unknown>)[key], path ? `${path}.${seg}` : seg, ctx, depth + 1, jsonDepth);
    }
}

/** 行主键里的随机段折叠掉，免得 icon_xxx / 预设时间戳把路径表冲爆。 */
const ID_COLLAPSE_PREFIXES = ['icon_', 'appearance_preset_', 'spark_', 'tama_board_img_', 'companion-', 'video-avatar-'];

export function normalizeRowId(id: string): string {
    for (const prefix of ID_COLLAPSE_PREFIXES) {
        if (id.startsWith(prefix)) return `${prefix}*`;
    }
    return id.replace(/[0-9a-f]{8,}/gi, '*').replace(/\d{6,}/g, '*');
}

/** blob_assets 的 id 属于哪一族（见 utils/blobStore.ts：这是张混用表）。 */
export function blobFamilyOf(id: string): string {
    if (id.startsWith('b_')) return 'blobref 图片（新）';
    if (id.startsWith('img_')) return 'blobref 图片（存量）';
    if (id.startsWith('video-avatar-')) return 'VRM 模型';
    if (id.includes('live2d-runtime-store')) return 'Live2D 缓存';
    if (id.startsWith('companion-')) return '陪伴语音';
    return '其他';
}

const yieldToMain = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const emptyTotals = (): SnapshotTotals => ({
    base64Count: 0, base64Bytes: 0, blobRefCount: 0, distinctRefs: 0, httpCount: 0,
    otherDataCount: 0, otherDataBytes: 0, embeddedBase64Count: 0, embeddedBase64Bytes: 0,
    binaryCount: 0, binaryBytes: 0,
});

/** 字段表压到上限内：留最占地方的那些，其余并成一条，别把导出文件撑大。 */
function trimFields(all: FieldStat[]): FieldStat[] {
    const weight = (f: FieldStat) =>
        f.base64Bytes + f.embeddedBase64Bytes + f.otherDataBytes + f.binaryBytes
        + (f.base64Count + f.blobRefCount) * 1024;   // 有图 / 有令牌的路径优先留，哪怕字节不大
    const sorted = [...all].sort((a, b) => weight(b) - weight(a));
    if (sorted.length <= MAX_FIELD_ROWS) return sorted;
    const kept = sorted.slice(0, MAX_FIELD_ROWS);
    const rest = sorted.slice(MAX_FIELD_ROWS);
    const merged: FieldStat = {
        store: '(其余路径合计)', path: `${rest.length} 条`, hits: 0,
        base64Count: 0, base64Bytes: 0, base64Mimes: {}, blobRefCount: 0, httpCount: 0,
        otherDataCount: 0, otherDataBytes: 0, embeddedBase64Count: 0, embeddedBase64Bytes: 0,
        embeddedRefCount: 0, binaryCount: 0, binaryBytes: 0, binaryMimes: {},
    };
    for (const f of rest) {
        merged.hits += f.hits;
        merged.base64Count += f.base64Count; merged.base64Bytes += f.base64Bytes;
        merged.blobRefCount += f.blobRefCount; merged.httpCount += f.httpCount;
        merged.otherDataCount += f.otherDataCount; merged.otherDataBytes += f.otherDataBytes;
        merged.embeddedBase64Count += f.embeddedBase64Count; merged.embeddedBase64Bytes += f.embeddedBase64Bytes;
        merged.embeddedRefCount += f.embeddedRefCount;
        merged.binaryCount += f.binaryCount; merged.binaryBytes += f.binaryBytes;
    }
    kept.push(merged);
    return kept;
}

/** localStorage 全量：只记键名（归一化）和长度，值一个字都不进报告。 */
export function scanLocalStorage(refs: Set<string>): LocalStorageStat {
    try {
        if (typeof localStorage === 'undefined') return { keyCount: 0, totalChars: 0, entries: [] };
        // 先同步快照再统计：中途有别处 removeItem 会让下标移位、漏掉一个键。
        const snapshot: Array<[string, string]> = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key === null) continue;
            snapshot.push([key, localStorage.getItem(key) ?? '']);
        }

        const byKey = new Map<string, LocalStorageEntryStat>();
        let totalChars = 0;
        for (const [key, value] of snapshot) {
            totalChars += value.length;
            const norm = normalizeRowId(key);
            let entry = byKey.get(norm);
            if (!entry) {
                entry = { key: norm, keys: 0, chars: 0, base64Count: 0, base64Chars: 0, blobRefCount: 0 };
                byKey.set(norm, entry);
            }
            entry.keys++;
            entry.chars += value.length;
            if (value.includes('data:image/')) {
                for (const m of value.matchAll(EMBEDDED_BASE64_RE)) {
                    entry.base64Count++;
                    entry.base64Chars += m[0].length;
                }
            }
            if (value.includes(BLOBREF_PREFIX)) {
                for (const m of value.matchAll(EMBEDDED_REF_RE)) {
                    entry.blobRefCount++;
                    refs.add(m[0]);   // localStorage 也是正经引用面，漏掉会把活图算成孤儿
                }
            }
        }

        const entries = [...byKey.values()].sort((a, b) => b.chars - a.chars);
        return {
            keyCount: snapshot.length,
            totalChars,
            entries: entries.slice(0, MAX_LS_ROWS),
        };
    } catch (e) {
        return { keyCount: 0, totalChars: 0, entries: [], error: describeError(e) };
    }
}

/**
 * 扫一遍当前存储长什么样。
 *
 * 每张表分页读、批间让出主线程；某张表读挂了只记在它自己那行的 error 上，不打断整轮
 * ——一张表读不出来不该让整份报告作废。
 */
export async function scanStorageSnapshot(onProgress?: (p: ScanProgress) => void): Promise<StorageSnapshot> {
    const startedAt = Date.now();
    const deadline = startedAt + SCAN_TIMEOUT_MS;
    const errors: string[] = [];
    const fields = new Map<string, FieldStat>();
    const refs = new Set<string>();
    const ctx: ScanCtx = { store: '', fields, refs, truncatedPaths: 0 };
    const stores: StoreScanInfo[] = [];
    /** blob_assets 逐条的 id → 字节数，用来算孤儿有多大 */
    const blobSizes = new Map<string, number>();
    const blobMimes: Record<string, { count: number; bytes: number }> = {};
    let timedOut = false;

    let db: IDBDatabase | null = null;
    try {
        db = await openDB();
    } catch (e) {
        errors.push(`主库连不上：${describeError(e)}`);
    }

    const storeNames = db ? Array.from(db.objectStoreNames) : [];

    // 进度总数先按行数摊平（count 不读行内容，几十 MB 的图不会被顺带读进来）
    let totalRows = 0;
    const rowCounts = new Map<string, number>();
    for (const name of storeNames) {
        try {
            const n = await DB.countStoreRows(name);
            rowCounts.set(name, n);
            totalRows += n;
        } catch {
            rowCounts.set(name, 0);
        }
    }
    let doneRows = 0;
    onProgress?.({ label: '准备中', done: 0, total: totalRows });

    for (const name of storeNames) {
        const rows = rowCounts.get(name) ?? 0;
        const info: StoreScanInfo = { store: name, rows, scanned: 0 };
        stores.push(info);
        ctx.store = name;
        let afterKey: IDBValidKey | null = null;
        try {
            for (;;) {
                const page = await DB.getStoreRowsPage(name, afterKey, PAGE_SIZE);
                for (const row of page.rows) {
                    info.scanned++;
                    // assets 的行 id 本身就是「这是哪个面」的关键信息（wallpaper？某个图标？
                    // 哪份预设？），并进路径里，否则整张表会糊成一条 data。
                    // blob_assets 的 id 是随机串，按族分（图片 / 模型 / 缓存），不然一份图一条路径。
                    const rowId = (row as { id?: unknown })?.id;
                    const prefix = typeof rowId !== 'string' ? ''
                        : name === 'assets' ? `[${normalizeRowId(rowId)}]`
                        : name === 'blob_assets' ? `[${blobFamilyOf(rowId)}]`
                        : '';
                    walkValue(row, prefix, ctx, 0, 0);
                    if (name === 'blob_assets' && typeof rowId === 'string') {
                        const blob = (row as { blob?: unknown }).blob;
                        const isBlob = typeof Blob !== 'undefined' && blob instanceof Blob;
                        const size = isBlob ? (blob as Blob).size : 0;
                        const mime = isBlob ? ((blob as Blob).type || '(空 MIME)') : '(非 Blob)';
                        blobSizes.set(rowId, size);
                        const slot = blobMimes[mime] ?? (blobMimes[mime] = { count: 0, bytes: 0 });
                        slot.count++; slot.bytes += size;
                    }
                }
                doneRows += page.rows.length;
                onProgress?.({ label: name, done: Math.min(doneRows, totalRows), total: totalRows });
                if (page.lastKey === null || page.rows.length < PAGE_SIZE) break;
                afterKey = page.lastKey;
                await yieldToMain();
                if (Date.now() > deadline) { timedOut = true; break; }
            }
        } catch (e) {
            info.error = describeError(e);
        }
        await yieldToMain();
        if (timedOut) { errors.push('扫描超时，后面的表没走完'); break; }
    }

    const localStorageStat = scanLocalStorage(refs);

    // ── blob_assets 对账：谁是孤儿，谁破图 ──
    let blobs: BlobStoreStat | null = null;
    if (blobSizes.size > 0 || storeNames.includes('blob_assets')) {
        const byFamily: Record<string, { count: number; bytes: number }> = {};
        let totalBytes = 0;
        let refIdCount = 0;
        let refIdBytes = 0;
        const refIdSet = new Set<string>();
        for (const [id, size] of blobSizes) {
            totalBytes += size;
            const family = blobFamilyOf(id);
            const slot = byFamily[family] ?? (byFamily[family] = { count: 0, bytes: 0 });
            slot.count++; slot.bytes += size;
            if (id.startsWith('b_') || id.startsWith('img_')) {
                refIdCount++; refIdBytes += size; refIdSet.add(id);
            }
        }
        // 令牌 → id：blobref: 前缀剥掉就是 blob_assets 的主键
        const referencedIds = new Set<string>();
        for (const token of refs) referencedIds.add(token.slice(BLOBREF_PREFIX.length));

        let orphanCount = 0, orphanBytes = 0;
        for (const id of refIdSet) {
            if (!referencedIds.has(id)) { orphanCount++; orphanBytes += blobSizes.get(id) ?? 0; }
        }
        const dangling: string[] = [];
        for (const id of referencedIds) {
            if (!refIdSet.has(id)) dangling.push(id);
        }
        blobs = {
            total: blobSizes.size, totalBytes, byFamily, byMime: blobMimes,
            refIdCount, refIdBytes,
            orphanCount, orphanBytes,
            danglingCount: dangling.length,
            // id 是随机串，不含用户内容，留几个样例方便回查
            danglingSamples: dangling.slice(0, 20),
        };
    }

    const allFields = [...fields.values()];
    const totals = emptyTotals();
    for (const f of allFields) {
        totals.base64Count += f.base64Count; totals.base64Bytes += f.base64Bytes;
        totals.blobRefCount += f.blobRefCount; totals.httpCount += f.httpCount;
        totals.otherDataCount += f.otherDataCount; totals.otherDataBytes += f.otherDataBytes;
        totals.embeddedBase64Count += f.embeddedBase64Count; totals.embeddedBase64Bytes += f.embeddedBase64Bytes;
        totals.binaryCount += f.binaryCount; totals.binaryBytes += f.binaryBytes;
    }
    totals.distinctRefs = refs.size;

    let overview: StorageOverview | null = null;
    try { overview = await readStorageOverview(); } catch (e) { errors.push(`读用量失败：${describeError(e)}`); }

    let breakdown: StorageBreakdown | null = null;
    try { breakdown = await computeStorageBreakdown(); } catch (e) { errors.push(`算分类占用失败：${describeError(e)}`); }

    return {
        at: new Date().toISOString(),
        scanMs: Date.now() - startedAt,
        dbName: db ? db.name : MAIN_DB_NAME,
        dbVersion: db ? db.version : null,
        overview, breakdown,
        stores: stores.filter(s => s.rows > 0 || s.error),
        fields: trimFields(allFields),
        totals,
        blobs,
        localStorage: localStorageStat,
        truncatedPaths: ctx.truncatedPaths,
        timedOut,
        errors,
    };
}

// ─── 报错捕获（诊断窗口期内）────────────────────────────────────

export interface CapturedIssue {
    at: string;
    source: 'console.error' | 'console.warn' | 'window.error' | 'unhandledrejection' | 'optimize';
    text: string;
}

const SECRET_HINT = /(sk-[A-Za-z0-9_-]{8,}|bearer\s+\S+|api[-_]?key|authorization|password|passwd|secret|refresh[-_]?token|"token"\s*:)/i;

/**
 * 报错文本脱敏。顺序要紧：先把 data URL 的正文换成长度（一段 base64 能有几 MB，
 * 而且那就是用户的图），再判有没有疑似密钥——整条丢掉总比赌哪一段是 key 稳。
 */
export function sanitizeIssueText(text: string): string {
    let t = text.replace(/data:[a-z0-9.+/-]*;base64,[A-Za-z0-9+/=]+/gi, m => `data:...(${m.length} 字符)`);
    if (SECRET_HINT.test(t)) return '[已隐去一条含疑似密钥的报错]';
    if (t.length > 400) t = `${t.slice(0, 400)}...(共 ${t.length} 字符)`;
    return t;
}

/** 逐条脱敏「失败原因 → 次数」，脱敏后撞成同一句的合并计数。 */
export function sanitizeReasons(reasons: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [reason, count] of Object.entries(reasons ?? {})) {
        const clean = sanitizeIssueText(reason);
        out[clean] = (out[clean] ?? 0) + count;
    }
    return out;
}

export function describeError(e: unknown): string {
    if (e instanceof Error) return sanitizeIssueText(`${e.name}: ${e.message}`);
    return sanitizeIssueText(String(e));
}

function argsToText(args: unknown[]): string {
    return args.map(a => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a)?.slice(0, 200) ?? String(a); } catch { return String(a); }
    }).join(' ');
}

/** 诊断跑的这段时间里把 console.error / warn 和两类全局报错收下来，跑完原样还回去。 */
export function installIssueCapture(sink: CapturedIssue[]): () => void {
    const MAX = 120;
    const push = (source: CapturedIssue['source'], text: string) => {
        if (sink.length >= MAX) return;
        sink.push({ at: new Date().toISOString(), source, text: sanitizeIssueText(text) });
    };

    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => { push('console.error', argsToText(args)); origError.apply(console, args as []); };
    console.warn = (...args: unknown[]) => { push('console.warn', argsToText(args)); origWarn.apply(console, args as []); };

    const onError = (e: ErrorEvent) => push('window.error', `${e.message} @ ${e.filename}:${e.lineno}`);
    const onRejection = (e: PromiseRejectionEvent) => push('unhandledrejection', argsToText([e.reason]));
    if (typeof window !== 'undefined') {
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
    }

    return () => {
        console.error = origError;
        console.warn = origWarn;
        if (typeof window !== 'undefined') {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
        }
    };
}

// ─── 整轮诊断 ──────────────────────────────────────────────────

export interface DiagnosticsStep {
    name: string;
    ok: boolean;
    ms: number;
    error?: string;
}

export interface DiagnosticsDelta {
    base64Count: { before: number; after: number };
    base64Bytes: { before: number; after: number };
    blobRefCount: { before: number; after: number };
    distinctRefs: { before: number; after: number };
    binaryBytes: { before: number; after: number };
    usageBytes: { before: number | null; after: number | null };
    indexedDbBytes: { before: number | null; after: number | null };
    orphan: { before: number; after: number };
    dangling: { before: number; after: number };
    /** 优化后还剩 base64 的路径——「哪些面还没接令牌链路」，这份报告最有价值的一栏 */
    base64Left: Array<{ store: string; path: string; count: number; bytes: number }>;
    /** 优化后新出现的破图（before 没有、after 有）——出现即是 bug */
    newDangling: number;
}

export interface DiagnosticsReport {
    kind: 'sullyos-storage-diagnostics';
    schema: 1;
    startedAt: string;
    finishedAt: string;
    totalMs: number;
    app: {
        version: string;
        build: string;
        buildTime: string;
    };
    env: {
        userAgent: string;
        language: string;
        platform: string;
        standalone: boolean | null;
        secureContext: boolean | null;
        cryptoSubtle: boolean;
        hardwareConcurrency: number | null;
        deviceMemory: number | null;
        screen: string | null;
        timeZone: string | null;
    };
    before: StorageSnapshot | null;
    optimize: {
        ok: boolean;
        ms: number;
        result: OptimizeResult | null;
        error: string | null;
        /** 进度回调走过的阶段（相邻重复的合并），能看出是在哪一步卡住 / 挂掉的 */
        stages: Array<{ label: string; rows: number }>;
    };
    after: StorageSnapshot | null;
    delta: DiagnosticsDelta | null;
    steps: DiagnosticsStep[];
    captured: CapturedIssue[];
    /** 报告本身生成过程中的问题（存盘失败之类） */
    notes: string[];
}

export type DiagnosticsPhase = 'before' | 'optimize' | 'after' | 'done';

export interface DiagnosticsProgress {
    phase: DiagnosticsPhase;
    label: string;
    done: number;
    total: number;
}

function collectEnv(): DiagnosticsReport['env'] {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    let standalone: boolean | null = null;
    try {
        standalone = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(display-mode: standalone)').matches
                || (nav as unknown as { standalone?: boolean })?.standalone === true
            : null;
    } catch { standalone = null; }
    let timeZone: string | null = null;
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null; } catch { timeZone = null; }
    return {
        userAgent: nav?.userAgent ?? '(未知)',
        language: nav?.language ?? '(未知)',
        platform: (nav as unknown as { platform?: string })?.platform ?? '(未知)',
        standalone,
        secureContext: typeof isSecureContext === 'boolean' ? isSecureContext : null,
        cryptoSubtle: typeof crypto !== 'undefined' && !!crypto.subtle,
        hardwareConcurrency: nav?.hardwareConcurrency ?? null,
        deviceMemory: (nav as unknown as { deviceMemory?: number })?.deviceMemory ?? null,
        screen: typeof screen !== 'undefined' ? `${screen.width}x${screen.height}@${globalThis.devicePixelRatio ?? 1}` : null,
        timeZone,
    };
}

function computeDelta(before: StorageSnapshot | null, after: StorageSnapshot | null): DiagnosticsDelta | null {
    if (!before || !after) return null;
    const base64Left = after.fields
        .filter(f => f.base64Count > 0 || f.embeddedBase64Count > 0)
        .map(f => ({
            store: f.store, path: f.path,
            count: f.base64Count + f.embeddedBase64Count,
            bytes: f.base64Bytes + f.embeddedBase64Bytes,
        }))
        .sort((a, b) => b.bytes - a.bytes);
    const beforeDangling = new Set(before.blobs?.danglingSamples ?? []);
    const newDangling = (after.blobs?.danglingSamples ?? []).filter(id => !beforeDangling.has(id)).length;
    return {
        base64Count: { before: before.totals.base64Count, after: after.totals.base64Count },
        base64Bytes: { before: before.totals.base64Bytes, after: after.totals.base64Bytes },
        blobRefCount: { before: before.totals.blobRefCount, after: after.totals.blobRefCount },
        distinctRefs: { before: before.totals.distinctRefs, after: after.totals.distinctRefs },
        binaryBytes: { before: before.totals.binaryBytes, after: after.totals.binaryBytes },
        usageBytes: { before: before.overview?.usageBytes ?? null, after: after.overview?.usageBytes ?? null },
        indexedDbBytes: { before: before.overview?.indexedDbBytes ?? null, after: after.overview?.indexedDbBytes ?? null },
        orphan: { before: before.blobs?.orphanCount ?? 0, after: after.blobs?.orphanCount ?? 0 },
        dangling: { before: before.blobs?.danglingCount ?? 0, after: after.blobs?.danglingCount ?? 0 },
        base64Left,
        newDangling,
    };
}

/**
 * 跑一整轮：扫优化前 → 跑优化 → 扫优化后。
 *
 * 每一步都各自 try/catch：前面挂了后面照跑，后面挂了前面的成果也照样能导出——测试者
 * 那边出岔子的时候，「只拿到半份报告」远比「什么都没有」有用。
 */
export async function runStorageDiagnostics(
    onProgress?: (p: DiagnosticsProgress) => void,
): Promise<DiagnosticsReport> {
    const startedAtMs = Date.now();
    const captured: CapturedIssue[] = [];
    const steps: DiagnosticsStep[] = [];
    const notes: string[] = [];
    const stopCapture = installIssueCapture(captured);

    const runStep = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
        const t0 = Date.now();
        try {
            const value = await fn();
            steps.push({ name, ok: true, ms: Date.now() - t0 });
            return value;
        } catch (e) {
            steps.push({ name, ok: false, ms: Date.now() - t0, error: describeError(e) });
            return null;
        }
    };

    let before: StorageSnapshot | null = null;
    let after: StorageSnapshot | null = null;
    const optimize: DiagnosticsReport['optimize'] = { ok: false, ms: 0, result: null, error: null, stages: [] };

    try {
        before = await runStep('扫描优化前状态', () =>
            scanStorageSnapshot(p => onProgress?.({ phase: 'before', label: p.label, done: p.done, total: p.total })));

        const optStart = Date.now();
        try {
            // 这里调的就是设置页那个「一键优化」按钮调的同一个函数、同一个签名。
            // 任何时候都不要在这儿套一层「诊断专用」的迁移，否则测的就不是用户跑的那条路。
            const result = await optimizeResourceStorage((p: OptimizeProgress) => {
                const last = optimize.stages[optimize.stages.length - 1];
                if (last && last.label === p.label) last.rows = p.done;
                else optimize.stages.push({ label: p.label, rows: p.done });
                onProgress?.({ phase: 'optimize', label: p.label, done: p.done, total: p.total });
            });
            optimize.ok = true;
            // 失败原因来自各种上游异常的 message，理论上可能捎带 data URL 片段，
            // 进报告前统一过一道脱敏（同名的合并计数）。
            optimize.result = { ...result, failureReasons: sanitizeReasons(result.failureReasons) };
            steps.push({ name: '一键优化', ok: true, ms: Date.now() - optStart });
        } catch (e) {
            optimize.error = describeError(e);
            captured.push({ at: new Date().toISOString(), source: 'optimize', text: optimize.error });
            steps.push({ name: '一键优化', ok: false, ms: Date.now() - optStart, error: optimize.error });
        }
        optimize.ms = Date.now() - optStart;

        after = await runStep('扫描优化后状态', () =>
            scanStorageSnapshot(p => onProgress?.({ phase: 'after', label: p.label, done: p.done, total: p.total })));
    } finally {
        stopCapture();
    }

    onProgress?.({ phase: 'done', label: '完成', done: 1, total: 1 });

    return {
        kind: 'sullyos-storage-diagnostics',
        schema: 1,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date().toISOString(),
        totalMs: Date.now() - startedAtMs,
        app: { version: APP_VERSION, build: BUILD_LABEL, buildTime: BUILD_TIME_LABEL },
        env: collectEnv(),
        before,
        optimize,
        after,
        delta: computeDelta(before, after),
        steps,
        captured,
        notes,
    };
}

// ─── 存盘 / 导出 ───────────────────────────────────────────────

export const DIAG_REPORT_KEY = 'sullyos_storage_diag_v1';

/** 去掉最占地方的逐路径明细，只留头几条——localStorage 塞不下整份时的降级形态。 */
function trimSnapshot(s: StorageSnapshot | null): StorageSnapshot | null {
    if (!s) return null;
    return { ...s, fields: s.fields.slice(0, 40), stores: s.stores.slice(0, 40) };
}

/**
 * 报告写进 localStorage，好让页面刷新（合并重复之后是要刷新的）之后还能导出。
 *
 * 会来点这个按钮的正是存储吃紧的用户，写不进去很正常：所以逐级瘦身重试，
 * 最后只剩摘要也认。全都写不进也不算失败——内存里那份还在，界面照样能导出，
 * 只是要提醒用户「别刷新，先导出」。
 */
export function saveReport(report: DiagnosticsReport): { saved: boolean; degraded: boolean; reason?: string } {
    const variants: Array<{ degraded: boolean; make: () => DiagnosticsReport }> = [
        { degraded: false, make: () => report },
        { degraded: true, make: () => ({ ...report, before: trimSnapshot(report.before), after: trimSnapshot(report.after) }) },
        { degraded: true, make: () => ({ ...report, before: null, after: null, captured: report.captured.slice(0, 10) }) },
    ];
    let lastError = '';
    for (const variant of variants) {
        try {
            localStorage.setItem(DIAG_REPORT_KEY, JSON.stringify(variant.make()));
            return { saved: true, degraded: variant.degraded };
        } catch (e) {
            lastError = describeError(e);
        }
    }
    return { saved: false, degraded: true, reason: lastError };
}

export function loadSavedReport(): DiagnosticsReport | null {
    try {
        const raw = localStorage.getItem(DIAG_REPORT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as DiagnosticsReport;
        return parsed?.kind === 'sullyos-storage-diagnostics' ? parsed : null;
    } catch {
        return null;
    }
}

export function clearSavedReport(): void {
    try { localStorage.removeItem(DIAG_REPORT_KEY); } catch { /* 清不掉就算了 */ }
}

export function reportFileName(report: DiagnosticsReport): string {
    const stamp = report.finishedAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    return `sullyos-storage-${report.app.version.split(' ')[0]}-${stamp}.json`;
}

export function reportToJson(report: DiagnosticsReport): string {
    return JSON.stringify(report, null, 2);
}

/** 导出成文件。iOS 上 <a download> 偶尔不灵，所以界面上另配了「复制」按钮兜底。 */
export function downloadReport(report: DiagnosticsReport): void {
    const blob = new Blob([reportToJson(report)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = reportFileName(report);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 界面上那几行人话摘要。 */
export function summarizeReport(report: DiagnosticsReport): string[] {
    const lines: string[] = [];
    const d = report.delta;
    const r = report.optimize.result;

    if (report.before) {
        lines.push(`优化前：${report.before.totals.base64Count} 张 base64 图（${formatBytes(report.before.totals.base64Bytes)}）、${report.before.totals.blobRefCount} 处令牌引用、${report.before.blobs?.total ?? 0} 份二进制（${formatBytes(report.before.blobs?.totalBytes ?? 0)}）`);
    } else {
        lines.push('优化前的扫描没做成（详见报告里的 steps）。');
    }

    if (report.optimize.ok && r) {
        lines.push(`优化：转了 ${r.converted} 处、新建 ${r.uniqueBlobs} 份 Blob、失败 ${r.failed} 处；合并重复 ${r.mergedDuplicates} 份、跳过 ${r.skippedGroups} 组；压缩记忆向量 ${r.vectorsCompacted} 条。`);
        const reasons = Object.entries(r.failureReasons ?? {}).sort((a, b) => b[1] - a[1]);
        if (reasons.length > 0) {
            lines.push(`转不动的原因：${reasons.slice(0, 3).map(([reason, n]) => `${reason}（${n} 处）`).join('；')}`);
        }
        if (r.vectorError) lines.push(`记忆向量那步没做完：${r.vectorError}`);
        if (r.scanUnavailable) lines.push('这次没能检查重复图片（多半是浏览器环境限制）。');
    } else {
        lines.push(`优化没跑成：${report.optimize.error ?? '未知原因'}`);
    }

    if (d) {
        lines.push(`优化后：base64 ${d.base64Count.before} → ${d.base64Count.after} 张（${formatBytes(d.base64Bytes.before)} → ${formatBytes(d.base64Bytes.after)}），令牌 ${d.blobRefCount.before} → ${d.blobRefCount.after} 处`);
        if (d.usageBytes.before != null && d.usageBytes.after != null) {
            lines.push(`浏览器实报用量：${formatBytes(d.usageBytes.before)} → ${formatBytes(d.usageBytes.after)}`);
        }
        if (d.orphan.after > 0) lines.push(`有 ${d.orphan.after} 份图没人引用了（${formatBytes(report.after?.blobs?.orphanBytes ?? 0)}），下次孤儿清理会回收。`);
        if (d.dangling.after > 0) lines.push(`注意：有 ${d.dangling.after} 处引用指向了不存在的图${d.newDangling > 0 ? `（其中 ${d.newDangling} 处是这轮新出现的）` : ''}，这是要查的问题。`);
        if (d.base64Left.length > 0) {
            const top = d.base64Left.slice(0, 3).map(f => `${f.store}.${f.path}`).join('、');
            lines.push(`还有 base64 留在 ${d.base64Left.length} 条路径上（最大的几条：${top}）。`);
        }
    }

    if (report.captured.length > 0) lines.push(`过程中记下了 ${report.captured.length} 条报错 / 警告。`);
    const failedSteps = report.steps.filter(s => !s.ok);
    if (failedSteps.length > 0) lines.push(`有 ${failedSteps.length} 个步骤没做成：${failedSteps.map(s => s.name).join('、')}。`);

    return lines;
}
