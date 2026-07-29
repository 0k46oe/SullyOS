import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMcpNameMap, filterMcpServersForChar, sanitizeMcpToolName, withMcpDedupeSuffix, type McpFireServer } from './mcpFireCore';

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
