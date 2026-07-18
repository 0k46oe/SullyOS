/**
 * amsg2 client_state 大值分块：服务端（@rei-standard/amsg-server）对单条 value 有
 * 200KB 硬上限（超了整批 413 STATE_VALUE_TOO_LARGE），但 fire_pack（角色卡 +
 * 世界书 + 最近对话）经常天然超过它。**内容一个字不删**——把 JSON 切成 N 条
 * `<key>.0` / `<key>.1` … 子条目上传，根条目 `<key>` 写一份小小的 chunk 元信息，
 * worker 到点按元信息拼回原文再 parse。
 *
 * 兼容性：老 worker 读到根条目的 meta JSON 时 parseFirePack / parseToolPack 形状
 * 校验不过 → 返回 null → 各自走冻结提示词 / 无工具数据的既有兜底，链不断。
 *
 * 纯函数、零依赖（客户端与 amsg worker bundle 共用，别 import 浏览器环境的东西）。
 */

/** 服务端 MAX_STATE_VALUE_BYTES = 200KB 的客户端镜像，留 4KB 余量。 */
export const AMSG_STATE_VALUE_SAFE_BYTES = 196 * 1024;

/**
 * 每块的 UTF-16 code unit 数。最坏情形全中文（1 unit = 3 utf8 字节）= 180KB，
 * emoji（2 units = 4 字节，摊 2 字节/unit）更小，必然 < 196KB 安全水位。
 */
export const AMSG_STATE_CHUNK_UNITS = 60_000;

export const amsgStateChunkKey = (key: string, index: number) => `${key}.${index}`;

const utf8 = new TextEncoder();
export const utf8ByteLength = (value: string): number => utf8.encode(value).length;

interface ChunkMeta {
  __chunked: 1;
  chunks: number;
}

const parseChunkMeta = (value: string): ChunkMeta | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' &&
      parsed.__chunked === 1 &&
      Number.isInteger(parsed.chunks) && parsed.chunks > 0
    ) {
      return parsed as ChunkMeta;
    }
  } catch { /* 非 JSON / 非 meta → null */ }
  return null;
};

/**
 * 装得下单条 → 原样返回（chunks 空，行为与历史完全一致）；
 * 超限 → 切块。切点避开代理对（emoji 不会被劈成两半的孤立 surrogate）。
 */
export function splitStateValue(json: string): { root: string; chunks: string[] } {
  if (utf8ByteLength(json) <= AMSG_STATE_VALUE_SAFE_BYTES) {
    return { root: json, chunks: [] };
  }
  const chunks: string[] = [];
  let pos = 0;
  while (pos < json.length) {
    let end = Math.min(pos + AMSG_STATE_CHUNK_UNITS, json.length);
    // 切点落在高位代理上 → 后挪一位，保住代理对。
    if (end < json.length) {
      const code = json.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end += 1;
    }
    chunks.push(json.slice(pos, end));
    pos = end;
  }
  const meta: ChunkMeta = { __chunked: 1, chunks: chunks.length };
  return { root: JSON.stringify(meta), chunks };
}

/**
 * worker 侧：根条目是 chunk meta 就按序拼回，缺任何一块（同步被打断/部分过期）
 * → null，调用方走既有兜底；不是 meta 就原样返回（单条老形态）。
 */
export function reassembleStateValue(
  root: string,
  getChunk: (index: number) => string | undefined,
): string | null {
  const meta = parseChunkMeta(root);
  if (!meta) return root;
  const parts: string[] = [];
  for (let i = 0; i < meta.chunks; i++) {
    const piece = getChunk(i);
    if (typeof piece !== 'string') return null;
    parts.push(piece);
  }
  return parts.join('');
}

/**
 * 客户端：把「namespace + key + 序列化好的 value」展开成 1 条（装得下）或
 * 1 根 + N 块（超限）的 putClientState entries。两个上传口子
 * （amsgStateSync 去抖冲刷 / 排任务即时同步）共用，别再各写各的。
 */
export function buildChunkedStateEntries(
  namespace: string,
  key: string,
  json: string,
  updatedAt: number,
): Array<{ namespace: string; key: string; value: string; updatedAt: number }> {
  const { root, chunks } = splitStateValue(json);
  return [
    { namespace, key, value: root, updatedAt },
    ...chunks.map((value, i) => ({
      namespace,
      key: amsgStateChunkKey(key, i),
      value,
      updatedAt,
    })),
  ];
}
