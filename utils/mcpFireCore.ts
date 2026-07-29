/**
 * mcpFireCore — 通用 MCP 的环境无关核心（浏览器 / amsg worker 共用叶子）。
 *
 * mcpClient.ts 管浏览器侧的事（localStorage 配置、代理包装、发现流程）；
 * 这里只放两端都要跑的纯逻辑：工具名映射、JSON-RPC 传输、正文假调用解析、
 * 结果格式化、后台 fire 的提示词块与 tools 数组。
 * （提示词块与 fire 侧 tools 数组由后续任务迁入。）
 *
 * 段落顺序是固定的，新东西插进对应分区，别往文件尾巴追加：
 *   共用类型 → 工具名与长度预算（含名映射）→ fire 侧服务器过滤
 *   → 工具结果回填 → 正文假调用解析 → JSON-RPC 传输层
 *
 * 环境无关叶子模块：不 import 任何带浏览器依赖的东西（会进 worker bundle）。
 */

// ========== 共用类型 ==========

export interface McpFireToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

/**
 * 上云 / 进 worker 的服务器形状：McpServerConfig 的结构子集
 * （没有 proxyUrl/proxyKey——worker 侧 fetch 没有 CORS，直连 url）。
 */
export interface McpFireServer {
    id: string;
    name: string;
    url: string;
    /** Bearer Token，可选（Authorization: Bearer <token>） */
    token?: string;
    customHeaders?: Array<{ name: string; value: string }>;
    /** 空/缺省 = 通用；非空 = 只有这些角色可见（与 mcpClient.getEnabledMcpServers 同语义） */
    charIds?: string[];
    tools?: McpFireToolDef[];
}

export interface McpResolvedToolCore<S extends McpFireServer = McpFireServer> {
    server: S;
    toolName: string;
    /** 工具定义本体，建映射时一并带出，省得调用方再按名字回服务器里反查 */
    tool: McpFireToolDef;
}

// ========== 工具名与长度预算 ==========

/** OpenAI 工具名的长度上限。 */
const DEFAULT_MAX_TOOL_NAME_LEN = 64;

// OpenAI 工具名只允许 [A-Za-z0-9_-]，最长 64；MCP 工具名可能带点号等。
// maxLen 可收紧：worker 侧要在暴露名前面拼 `mcp__` 前缀，得先给前缀留出位置。
// 预算是算出来的（上限减前缀长度），万一算成 0 或负数，这里兜到至少留 1 个字符，
// 免得返回空串或者被 slice 的负数下标倒着截。
export const sanitizeMcpToolName = (name: string, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string => {
    const len = Math.max(1, maxLen);
    return (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, len);
};

/** 重名兜底后缀：基名先截到给 `_<i>` 留位的长度，避免截断吃掉计数器后候选名不再变化。 */
export const withMcpDedupeSuffix = (base: string, i: number, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string => {
    const suffix = `_${i}`;
    // 预算比后缀本身还短时，留位长度会变负数，slice 会从尾巴倒着截、反而吐出一长串；
    // 夹到 0 之后这种极端情况拿到的是纯后缀，长度仍然可控，计数器也照样能区分。
    return base.slice(0, Math.max(0, maxLen - suffix.length)) + suffix;
};

const serverSlug = (server: McpFireServer, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string =>
    sanitizeMcpToolName(server.name, maxLen).slice(0, 20);

/**
 * 暴露名 → 真实工具 的映射。暴露名默认用工具原名（sanitize 后）；
 * 跨服务器重名时后者加 <服务器名>_ 前缀。前台 buildMcpOpenAITools 与
 * worker fire 路径都用这一份，保证两端看到同一套名字。
 *
 * maxNameLen：暴露名的长度预算，缺省 64（OpenAI 上限）。worker 侧传更小的值，
 * 好给后面要拼的 `mcp__` 前缀留位。
 */
export const buildMcpNameMap = <S extends McpFireServer>(
    servers: S[],
    opts: { maxNameLen?: number } = {},
): Map<string, McpResolvedToolCore<S>> => {
    const maxLen = opts.maxNameLen ?? DEFAULT_MAX_TOOL_NAME_LEN;
    const resolve = new Map<string, McpResolvedToolCore<S>>();
    for (const server of servers) {
        for (const t of server.tools || []) {
            let exposed = sanitizeMcpToolName(t.name, maxLen);
            if (resolve.has(exposed)) {
                // 带服务器前缀再试；还撞就在后面挂计数器（计数器由 withMcpDedupeSuffix 保位）
                const prefixed = sanitizeMcpToolName(`${serverSlug(server, maxLen)}_${t.name}`, maxLen);
                exposed = prefixed;
                let i = 2;
                while (resolve.has(exposed)) exposed = withMcpDedupeSuffix(prefixed, i++, maxLen);
            }
            resolve.set(exposed, { server, toolName: t.name, tool: t });
        }
    }
    return resolve;
};

// ========== fire 侧服务器过滤 ==========

/**
 * fire 时按角色过滤可见服务器（charIds 语义与 getEnabledMcpServers 一致）。
 * 只管 url / tools / charIds 三项：服务器有没有启用由上云侧的
 * collectMcpFireServers 把关，传到这里的清单已经只剩启用的。
 */
export const filterMcpServersForChar = <S extends McpFireServer>(
    servers: S[] | undefined,
    charId: string,
): S[] =>
    (servers || []).filter((s) =>
        !!s.url && (s.tools?.length || 0) > 0 &&
        (!s.charIds?.length || s.charIds.includes(charId)),
    );

// ========== 工具结果回填 ==========

/**
 * MCP 结果（记忆检索、网页抓取等）体量远超瑞幸商品列表，1500 字符会把一条
 * 完整结果拦腰截断。上限放到 20000 只防病态超长结果炸上下文——工具循环每轮
 * 会全量重发消息，真有兆级 JSON 混进来会直接 4xx 或 token 起飞。
 */
export const MCP_RESULT_MAX_CHARS = 20000;

export const formatMcpToolResult = (data: any): string => {
    let s: string;
    try { s = typeof data === 'string' ? data : JSON.stringify(data); } catch { s = String(data); }
    return s.length > MCP_RESULT_MAX_CHARS
        ? `${s.slice(0, MCP_RESULT_MAX_CHARS)}…[结果过长已截断, 全文共 ${s.length} 字符]`
        : s;
};

// ========== 掉格式容错: 正文里的"假工具调用" ==========
//
// 不支持 function calling 的模型（或被中转剥了 tools 参数的）看到系统块里的
// 工具清单后, 会把调用直接"演"在正文里, 常见形态:
//   ask_question("SullyOS")           ← 括号传参
//   ask_question: SullyOS             ← 冒号传参（整行）
//   get_weather({"city": "上海"})     ← 括号传 JSON
// 与见面观测协议同款思路的两层容错: FC 通道是第一层, 这里兜第二层。
// 只认已启用服务器的真实工具名（暴露名/原名都认）, 避免误伤普通文字。

export interface FakedMcpCall<S extends McpFireServer = McpFireServer> {
    exposedName: string;
    server: S;
    toolName: string;
    args: Record<string, any>;
    matched: string;
}

/** 从正文兼容调用中剥掉调用语法，只留下可以先展示给用户的角色文字。 */
export const stripTextFakedMcpCalls = (content: string, calls: Array<{ matched: string }>): string => {
    let cleaned = content;
    for (const call of calls) cleaned = cleaned.split(call.matched).join('');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const stripQuotes = (s: string): string => {
    const t = s.trim();
    const m = t.match(/^(['"`「『])([\s\S]*)(['"`」』])$/);
    return m ? m[2] : t;
};

/** schema 的参数名顺序: required 优先, 其余按声明序 —— 用于位置参数落位 */
const positionalKeys = (schema: any): string[] => {
    const props = schema?.properties ? Object.keys(schema.properties) : [];
    const req = Array.isArray(schema?.required) ? schema.required.filter((k: string) => props.includes(k)) : [];
    return [...req, ...props.filter(k => !req.includes(k))];
};

const coerceBySchema = (value: string, schema: any, key: string): any => {
    const type = schema?.properties?.[key]?.type;
    const v = stripQuotes(value);
    if (type === 'number' || type === 'integer') {
        const n = Number(v);
        if (Number.isFinite(n)) return type === 'integer' ? Math.trunc(n) : n;
    }
    if (type === 'boolean') {
        if (/^(true|是|开)$/i.test(v)) return true;
        if (/^(false|否|关)$/i.test(v)) return false;
    }
    return v;
};

/** 顶层逗号切分（尊重引号与花括号嵌套） */
const splitTopLevel = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0, cur = '', quote = '';
    for (const ch of s) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
};

/** 把括号里的原始文本解析成 args 对象（JSON / kwargs / 位置参数三种形态） */
const parseFakedArgs = (inner: string, schema: any): Record<string, any> => {
    const t = inner.trim();
    if (!t) return {};
    // JSON 形态
    if (t.startsWith('{')) {
        try { return JSON.parse(t); } catch { /* 尝试宽松修复 */ }
        try {
            return JSON.parse(t
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/'/g, '"')
                .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
        } catch { /* 落回单参数 */ }
    }
    const parts = splitTopLevel(t);
    // kwargs 形态: key=value / key: value
    if (parts.every(p => /^\s*[A-Za-z_]\w*\s*[=:]/.test(p))) {
        const args: Record<string, any> = {};
        for (const p of parts) {
            const m = p.match(/^\s*([A-Za-z_]\w*)\s*[=:]\s*([\s\S]*)$/);
            if (m) args[m[1]] = coerceBySchema(m[2], schema, m[1]);
        }
        return args;
    }
    // 位置参数形态: 按 schema 声明顺序落位
    const keys = positionalKeys(schema);
    const args: Record<string, any> = {};
    parts.forEach((p, i) => {
        const key = keys[i];
        if (key) args[key] = coerceBySchema(p, schema, key);
    });
    return args;
};

/**
 * 从 AI 正文里提取"假工具调用"。只匹配 resolve 里已知的工具名（暴露名/真实名）。
 * 返回按出现位置排序、按 matched 文本去重的调用列表。
 */
export const extractTextFakedMcpCalls = <S extends McpFireServer>(
    content: string,
    resolve: Map<string, McpResolvedToolCore<S>>,
): FakedMcpCall<S>[] => {
    if (!content || !resolve.size) return [];

    // 名字查找表: 暴露名和真实工具名都认（模型两种都可能写）
    const lookup = new Map<string, { exposed: string; hit: McpResolvedToolCore<S> }>();
    for (const [exposed, hit] of resolve) {
        lookup.set(exposed, { exposed, hit });
        lookup.set(hit.toolName, { exposed, hit });
    }

    const found: Array<FakedMcpCall<S> & { index: number }> = [];
    const seen = new Set<string>();

    for (const [name, { exposed, hit }] of lookup) {
        const schema = hit.tool.inputSchema;
        const esc = escapeRegExp(name);

        // 形态1: name(args) —— 前面不能是单词字符/点/斜杠（防止匹配到更长标识符的一部分）
        const parenRe = new RegExp(`(^|[^\\w./])${esc}\\s*\\(([^)]*)\\)`, 'g');
        for (const m of content.matchAll(parenRe)) {
            const matched = m[0].slice(m[1].length);
            const key = `${exposed}|${matched}`;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({
                exposedName: exposed,
                server: hit.server,
                toolName: hit.toolName,
                args: parseFakedArgs(m[2], schema),
                matched,
                index: (m.index ?? 0) + m[1].length,
            });
        }

        // 形态2: 行首 name: 值 —— 限定行首, 避免误伤句中"提到"工具名的普通文字
        const colonRe = new RegExp(`(^|\\n)\\s*[>*-]*\\s*\`?${esc}\`?\\s*[:：]\\s*([^\\n]+)`, 'g');
        for (const m of content.matchAll(colonRe)) {
            const matched = m[0].slice(m[1].length);
            const key = `${exposed}|${matched.trim()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const keys = positionalKeys(schema);
            const value = stripQuotes(m[2].replace(/[。！？!?…\s]+$/, ''));
            found.push({
                exposedName: exposed,
                server: hit.server,
                toolName: hit.toolName,
                args: keys.length ? { [keys[0]]: coerceBySchema(value, schema, keys[0]) } : {},
                matched,
                index: (m.index ?? 0) + m[1].length,
            });
        }
    }

    return found
        .sort((a, b) => a.index - b.index)
        .map(({ index: _index, ...call }) => call);
};
