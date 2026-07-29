/**
 * mcpFireCore — 通用 MCP 的环境无关核心（浏览器 / amsg worker 共用叶子）。
 *
 * mcpClient.ts 管浏览器侧的事（localStorage 配置、代理包装、发现流程）；
 * 这里只放两端都要跑的纯逻辑：工具名映射、JSON-RPC 传输、正文假调用解析、
 * 结果格式化、后台 fire 的提示词块与 tools 数组。
 * （传输/解析/提示词块由后续任务陆续迁入，本文件先落名映射。）
 *
 * 环境无关叶子模块：不 import 任何带浏览器依赖的东西（会进 worker bundle）。
 */

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

/** OpenAI 工具名的长度上限。 */
const DEFAULT_MAX_TOOL_NAME_LEN = 64;

// OpenAI 工具名只允许 [A-Za-z0-9_-]，最长 64；MCP 工具名可能带点号等。
// maxLen 可收紧：worker 侧要在暴露名前面拼 `mcp__` 前缀，得先给前缀留出位置。
export const sanitizeMcpToolName = (name: string, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string =>
    (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, maxLen);

/** 重名兜底后缀：基名先截到给 `_<i>` 留位的长度，避免截断吃掉计数器后候选名不再变化。 */
export const withMcpDedupeSuffix = (base: string, i: number, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string => {
    const suffix = `_${i}`;
    return base.slice(0, maxLen - suffix.length) + suffix;
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
