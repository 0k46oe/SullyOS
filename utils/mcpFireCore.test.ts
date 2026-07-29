import { describe, expect, it } from 'vitest';
import { buildMcpNameMap, filterMcpServersForChar, type McpFireServer } from './mcpFireCore';

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
