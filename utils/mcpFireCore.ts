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
}

// OpenAI 工具名只允许 [A-Za-z0-9_-]，最长 64；MCP 工具名可能带点号等
export const sanitizeMcpToolName = (name: string): string =>
    (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';

const serverSlug = (server: McpFireServer): string =>
    sanitizeMcpToolName(server.name).slice(0, 20) || 'srv';

/**
 * 暴露名 → 真实工具 的映射。暴露名默认用工具原名（sanitize 后）；
 * 跨服务器重名时后者加 <服务器名>_ 前缀。前台 buildMcpOpenAITools 与
 * worker fire 路径都用这一份，保证两端看到同一套名字。
 */
export const buildMcpNameMap = <S extends McpFireServer>(
    servers: S[],
): Map<string, McpResolvedToolCore<S>> => {
    const resolve = new Map<string, McpResolvedToolCore<S>>();
    for (const server of servers) {
        for (const t of server.tools || []) {
            let exposed = sanitizeMcpToolName(t.name);
            if (resolve.has(exposed)) {
                exposed = sanitizeMcpToolName(`${serverSlug(server)}_${t.name}`);
                let i = 2;
                while (resolve.has(exposed)) exposed = sanitizeMcpToolName(`${serverSlug(server)}_${t.name}_${i++}`);
            }
            resolve.set(exposed, { server, toolName: t.name });
        }
    }
    return resolve;
};

/** fire 时按角色过滤可见服务器（与 getEnabledMcpServers 的 charIds 语义一致）。 */
export const filterMcpServersForChar = <S extends McpFireServer>(
    servers: S[] | undefined,
    charId: string,
): S[] =>
    (servers || []).filter((s) =>
        !!s.url && (s.tools?.length || 0) > 0 &&
        (!s.charIds?.length || s.charIds.includes(charId)),
    );
