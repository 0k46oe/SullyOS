import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildMcpDirectHeaders,
    buildMcpFireBlock,
    buildMcpFireTools,
    buildMcpNameMap,
    callMcpToolCore,
    createMcpSessionState,
    filterMcpServersForChar,
    sanitizeMcpToolName,
    withMcpDedupeSuffix,
    type McpFireServer,
    type McpTransportTarget,
} from './mcpFireCore';

const srv = (over: Partial<McpFireServer>): McpFireServer => ({
    id: 's1', name: '服务器A', url: 'https://a.example.com/mcp',
    tools: [{ name: 'get_weather' }],
    ...over,
});

describe('buildMcpNameMap', () => {
    it('工具名 sanitize 成 OpenAI 允许的字符集', () => {
        const map = buildMcpNameMap([srv({ tools: [{ name: 'ns.get/weather' }] })]);
        expect([...map.keys()]).toEqual(['ns_get_weather']);
        expect(map.get('ns_get_weather')).toMatchObject({ toolName: 'ns.get/weather' });
    });

    it('跨服务器重名时后者加服务器前缀', () => {
        const map = buildMcpNameMap([
            srv({ id: 's1', name: 'AAA', tools: [{ name: 'search' }] }),
            srv({ id: 's2', name: 'BBB', tools: [{ name: 'search' }] }),
        ]);
        expect([...map.keys()]).toEqual(['search', 'BBB_search']);
        expect(map.get('BBB_search')?.server.id).toBe('s2');
    });

    // 下面两条守的是同一个坑：兜底后缀被 64 字符上限截掉后，候选名恒定不变、
    // while 循环再也退不出去。第一条才是真正的回归守卫——同步死循环会把
    // 整个 vitest 进程卡住，testTimeout 也救不回来，红不了。
    it('重名后缀不会被 64 字符上限吃掉：不同计数必须得到不同名字', () => {
        const base = 'x'.repeat(64);
        const a = withMcpDedupeSuffix(base, 2);
        const b = withMcpDedupeSuffix(base, 3);
        expect(a).not.toBe(b);
        expect(a.length).toBeLessThanOrEqual(64);
    });

    it('前 20 字符同名的多台服务器 + 撑满 64 的工具名，每个工具仍拿到互异的暴露名', () => {
        const longTool = 'a'.repeat(43);
        const servers = ['-alpha', '-beta', '-gamma', '-delta'].map((sfx, i) =>
            srv({ id: `s${i}`, name: `MyCompanyToolServer${sfx}`, tools: [{ name: longTool }] }));
        const map = buildMcpNameMap(servers);
        expect(map.size).toBe(servers.length);
        expect([...map.keys()].every((k) => k.length <= 64)).toBe(true);
    });

    it('maxNameLen 可收紧预算（给 worker 侧的 mcp__ 前缀留位），收紧后暴露名依然互异', () => {
        const longTool = 'a'.repeat(43);
        const servers = ['-alpha', '-beta', '-gamma', '-delta'].map((sfx, i) =>
            srv({ id: `s${i}`, name: `MyCompanyToolServer${sfx}`, tools: [{ name: longTool }] }));
        const map = buildMcpNameMap(servers, { maxNameLen: 59 });
        // Map 的键天然去重，size 等于工具数就等于「没有互相覆盖」
        expect(map.size).toBe(servers.length);
        expect([...map.keys()].every((k) => k.length <= 59)).toBe(true);
    });
});

describe('工具名长度预算', () => {
    // 名长预算是调用方算出来的（上限减前缀），算出 0 或负数时不能给出怪结果：
    // 不许返回空名，也不许被 slice 的负数下标反过来吐出一长串。
    it('名长预算被压到 0/负数时仍给出可用的短名字', () => {
        expect(sanitizeMcpToolName('xyz', 0)).toBe('x');
        expect(sanitizeMcpToolName('xyz', -5)).toBe('x');
        expect(withMcpDedupeSuffix('abc', 2, 1)).toBe('_2');
        expect(withMcpDedupeSuffix('x'.repeat(64), 2, 1).length).toBeLessThanOrEqual('_2'.length);
    });
});

describe('filterMcpServersForChar', () => {
    it('charIds 为空 = 通用；非空 = 只对绑定角色可见', () => {
        const servers = [
            srv({ id: 'g', charIds: undefined }),
            srv({ id: 'bound', charIds: ['char-1'] }),
            srv({ id: 'other', charIds: ['char-2'] }),
        ];
        expect(filterMcpServersForChar(servers, 'char-1').map((s) => s.id)).toEqual(['g', 'bound']);
    });

    it('没有 url 或没发现工具的不进清单; 入参 undefined 得空数组', () => {
        expect(filterMcpServersForChar([srv({ url: '' }), srv({ tools: [] })], 'c')).toEqual([]);
        expect(filterMcpServersForChar(undefined, 'c')).toEqual([]);
    });
});

// 浏览器那条路径由 mcpClient.test.ts 盖住；这里守的是 worker 直连——请求头
// 自己拼、会话状态自己拿着，所以断言要看真实发出去的请求体和请求头。
describe('JSON-RPC 传输层（直连路径）', () => {
    interface SentRequest {
        url: string;
        headers: Record<string, string>;
        body: any;
    }

    const directServer = (over: Partial<McpFireServer> = {}): McpFireServer => srv({
        token: 'tk-1',
        customHeaders: [{ name: 'X-Api-Key', value: 'k1' }],
        ...over,
    });

    const directTarget = (server: McpFireServer): McpTransportTarget => ({
        url: server.url,
        headers: (sessionId) => buildMcpDirectHeaders(server, sessionId),
    });

    const jsonResp = (payload: any, extraHeaders: Record<string, string> = {}): Response =>
        new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...extraHeaders },
        });

    /** 把每次 fetch 的 URL / 头 / 请求体记下来，由 handler 决定回什么 */
    const stubFetch = (handler: (sent: SentRequest) => Response): SentRequest[] => {
        const sent: SentRequest[] = [];
        vi.stubGlobal('fetch', vi.fn((url: any, init: any) => {
            const record: SentRequest = {
                url: String(url),
                headers: (init?.headers || {}) as Record<string, string>,
                body: JSON.parse(String(init?.body || '{}')),
            };
            sent.push(record);
            return Promise.resolve(handler(record));
        }));
        return sent;
    };

    beforeEach(() => {
        vi.spyOn(console, 'info').mockImplementation(() => { /* 别刷屏 */ });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('一次 tools/call 依次发出 initialize → notifications/initialized → tools/call，直连头带鉴权和自定义头', async () => {
        const server = directServer();
        const sent = stubFetch(({ body }) => {
            if (body.method === 'initialize') return jsonResp({ jsonrpc: '2.0', id: body.id, result: {} });
            if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
            return jsonResp({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"temp":21}' }] } });
        });

        const result = await callMcpToolCore(
            directTarget(server), createMcpSessionState(), 'get_weather', { city: '上海' },
        );

        expect(result).toMatchObject({ success: true, data: { temp: 21 } });
        expect(sent.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
        expect(sent.every((s) => s.url === server.url)).toBe(true);
        expect(sent[0].headers['Authorization']).toBe('Bearer tk-1');
        expect(sent[0].headers['X-Api-Key']).toBe('k1');
        expect(sent[0].headers['Accept']).toBe('application/json, text/event-stream');
        // 还没握手完，第一发不该凭空带 session
        expect(sent[0].headers['Mcp-Session-Id']).toBeUndefined();
        expect(sent[2].body.params).toEqual({ name: 'get_weather', arguments: { city: '上海' } });
    });

    it('initialize 响应头里的 Mcp-Session-Id 记进会话，之后每一发都带上', async () => {
        const server = directServer();
        const sent = stubFetch(({ body }) => {
            if (body.method === 'initialize') {
                return jsonResp({ jsonrpc: '2.0', id: body.id, result: {} }, { 'Mcp-Session-Id': 'sess-A' });
            }
            if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
            return jsonResp({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        });

        const session = createMcpSessionState();
        await callMcpToolCore(directTarget(server), session, 'get_weather', {});

        expect(session.sessionId).toBe('sess-A');
        expect(sent[1].headers['Mcp-Session-Id']).toBe('sess-A');
        expect(sent[2].headers['Mcp-Session-Id']).toBe('sess-A');
    });

    it('tools/call 撞上 HTTP 404 时重置会话、重新握手并重试一次', async () => {
        const server = directServer();
        let handshakes = 0;
        let toolCalls = 0;
        const sent = stubFetch(({ body }) => {
            if (body.method === 'initialize') {
                return jsonResp({ jsonrpc: '2.0', id: body.id, result: {} }, { 'Mcp-Session-Id': `sess-${++handshakes}` });
            }
            if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
            toolCalls++;
            // 服务器重启后老 session 失效，第一发 tools/call 被判 404
            if (toolCalls === 1) return new Response('session expired', { status: 404 });
            return jsonResp({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        });

        // 和 mcpClient 的真实用法一致：会话对象由外面拿着，不传任何额外选项
        const session = createMcpSessionState();
        const result = await callMcpToolCore(directTarget(server), session, 'get_weather', {});

        expect(result).toMatchObject({ success: true, data: 'ok' });
        // 握手真的重来了一遍，而不是拿 initialized 的旧会话直接重发
        expect(handshakes).toBe(2);
        expect(toolCalls).toBe(2);
        // 重试带的是新握手拿到的 session，而不是拿失效的那个再撞一次
        expect(sent[sent.length - 1].headers['Mcp-Session-Id']).toBe('sess-2');
        expect(session.sessionId).toBe('sess-2');
    });

    it('远端一直不回响应时按 timeoutMs 超时，返回失败结果而不是永久挂着', async () => {
        vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })));

        const result = await callMcpToolCore(
            directTarget(directServer()), createMcpSessionState(), 'get_weather', {}, { timeoutMs: 20 },
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('超时');
    });

    it('JSON-RPC id 按会话独立计数：两个会话都从 1 起，互不串号', async () => {
        const server = directServer();
        const sent = stubFetch(({ body }) => {
            if (body.method === 'initialize') return jsonResp({ jsonrpc: '2.0', id: body.id, result: {} });
            if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
            return jsonResp({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        });

        const first = createMcpSessionState();
        const second = createMcpSessionState();
        await callMcpToolCore(directTarget(server), first, 'get_weather', {});
        await callMcpToolCore(directTarget(server), second, 'get_weather', {});

        // 通知类请求本来就没有 id；两个会话各自数出 1（initialize）和 2（tools/call）
        expect(sent.map((s) => s.body.id)).toEqual([1, undefined, 2, 1, undefined, 2]);
        expect(first.nextId).toBe(2);
        expect(second.nextId).toBe(2);
    });
});

describe('buildMcpFireBlock / buildMcpFireTools', () => {
    const servers = [srv({
        tools: [{
            name: 'get_weather',
            description: '查天气',
            inputSchema: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'number' } }, required: ['city'] },
        }],
    })];
    const map = buildMcpNameMap(servers);

    it('native 模式：只讲纪律，不教正文协议', () => {
        const block = buildMcpFireBlock(map, { mode: 'native' });
        expect(block).toContain('get_weather');
        expect(block).toContain('不要编造结果');
        expect(block).not.toContain('tool_name({"参数":"值"})');
    });

    it('text 模式：签名含必填星标与类型，教正文协议', () => {
        const block = buildMcpFireBlock(map, { mode: 'text' });
        expect(block).toContain('get_weather(city*:string, days:number)');
        expect(block).toContain('tool_name({"参数":"值"})');
    });

    it('空映射返回空串（不往 prompt 里塞空壳）', () => {
        expect(buildMcpFireBlock(new Map(), { mode: 'native' })).toBe('');
    });

    it('fire tools 数组带 mcp__ 前缀与来源标注', () => {
        const tools = buildMcpFireTools(map);
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
            type: 'function',
            function: { name: 'mcp__get_weather', description: '[服务器A] 查天气' },
        });
        expect((tools[0].function as any).parameters.required).toEqual(['city']);
    });

    // 59 是 worker 侧算好的预算（64 上限 - `mcp__` 前缀 5 字符）。这条守的是两边协同：
    // 名映射按 59 收紧后，fire tools 拼上前缀不能越过 OpenAI 的 64。
    it('按 maxNameLen: 59 建的映射，拼上 mcp__ 前缀后仍不超 64', () => {
        const longTool = 'a'.repeat(43);
        const wideServers = ['-alpha', '-beta', '-gamma', '-delta'].map((sfx, i) =>
            srv({ id: `s${i}`, name: `MyCompanyToolServer${sfx}`, tools: [{ name: longTool }] }));
        const tools = buildMcpFireTools(buildMcpNameMap(wideServers, { maxNameLen: 59 }));
        expect(tools).toHaveLength(wideServers.length);
        expect(tools.every((t) => t.function.name.startsWith('mcp__'))).toBe(true);
        expect(tools.every((t) => t.function.name.length <= 64)).toBe(true);
    });
});

describe('叶子纪律', () => {
    // 这份文件会被打进 amsg worker bundle，import 到带浏览器依赖的模块就会在
    // worker 里炸。靠源码扫描当场拦住，不用等到构建才发现。
    it('mcpFireCore 保持环境无关：不 import 任何模块', () => {
        const src = readFileSync(new URL('./mcpFireCore.ts', import.meta.url), 'utf8');
        // 后续任务确需引入环境无关叶子时，在这里逐条放开白名单
        expect(src.match(/^\s*import\s.+$/gm) ?? []).toEqual([]);
        // 连 `export … 自其它模块` 这种转出写法一起卡（它同样会把别的模块拖进 bundle）
        expect(src.match(/\bfrom\s*['"]/g) ?? []).toEqual([]);
        // 动态引入同理，运行期才炸更难查
        expect(src.match(/\bimport\s*\(/g) ?? []).toEqual([]);
    });
});
