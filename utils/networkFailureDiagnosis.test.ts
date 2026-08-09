// utils/networkFailureDiagnosis.test.ts
// 回归守卫：
//   1. 调试终端里那条 network 日志不能再退回「Failed to fetch + 一个 URL」——方法、耗时、
//      在线状态、跨域与否、初判、可能原因，少一样用户就又只能来问作者。
//   2. 分类不能认错：主动取消 / 离线 / https 打 http / 地址非法 这四种都有确定结论，
//      混进 blocked 会白白多打一次探测，还会给出跑偏的排查方向。
//   3. no-cors 复检的两个结论必须泾渭分明：「通了」指向 CORS/限流，「没通」指向线路，
//      两边要查的东西完全相反，说反了比不说更糟。
//   4. 探测有 30s 冷却：一串请求同时炸时不能对同一个域名连打探测。
import { describe, it, expect, beforeEach } from 'vitest';
import {
    NETWORK_SELF_CHECK_STEPS,
    buildFetchFailureDetail,
    classifyFetchFailure,
    describeReachabilityProbe,
    parseTargetUrl,
    probeOriginReachability,
    readResourceTimingHint,
    resetReachabilityProbeCooldown,
} from './networkFailureDiagnosis';

const failedToFetch = () => new TypeError('Failed to fetch');

describe('classifyFetchFailure', () => {
    it('Chrome / Safari / Firefox 三种说法都算「拿不到响应」', () => {
        for (const msg of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource']) {
            expect(classifyFetchFailure({
                url: 'https://sullymeow.ccwu.cc/api/health',
                error: new TypeError(msg),
                online: true,
                pageProtocol: 'https:',
            })).toBe('blocked');
        }
    });

    it('主动取消不算网络失败', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        expect(classifyFetchFailure({ url: 'https://a.example.com/x', error: err })).toBe('aborted');
    });

    it('浏览器报离线时优先归到离线', () => {
        expect(classifyFetchFailure({
            url: 'https://a.example.com/x', error: failedToFetch(), online: false, pageProtocol: 'https:',
        })).toBe('offline');
    });

    it('https 页面打 http 地址 → 混合内容，且优先级高于离线判定', () => {
        expect(classifyFetchFailure({
            url: 'http://a.example.com/x', error: failedToFetch(), online: false, pageProtocol: 'https:',
        })).toBe('mixed-content');
    });

    it('http://localhost 不当混合内容拦（Chrome 视其为可信来源）', () => {
        expect(classifyFetchFailure({
            url: 'http://localhost:18060/api/health', error: failedToFetch(), online: true, pageProtocol: 'https:',
        })).toBe('blocked');
    });

    it('地址本身不合法 → bad-url', () => {
        expect(classifyFetchFailure({
            url: 'sullymeow ccwu cc/api', error: failedToFetch(), online: true, pageProtocol: 'https:',
        })).toBe('bad-url');
    });
});

describe('buildFetchFailureDetail', () => {
    const detail = () => buildFetchFailureDetail({
        url: 'https://sullymeow.ccwu.cc/api/health',
        method: 'get',
        durationMs: 43,
        error: failedToFetch(),
        online: true,
        pageOrigin: 'https://sullyos.example.com',
        pageProtocol: 'https:',
    }, { perf: { getEntriesByName: () => [] } });

    it('把能补的旁证全补上', () => {
        const text = detail();
        expect(text).toContain('URL: https://sullymeow.ccwu.cc/api/health');
        expect(text).toContain('GET');
        expect(text).toContain('43ms');
        expect(text).toContain('TypeError: Failed to fetch');
        expect(text).toContain('sullymeow.ccwu.cc');
        expect(text).toContain('跨域');
        expect(text).toContain('在线');
        expect(text).toContain('初判:');
        expect(text).toContain('可能原因:');
    });

    it('同源请求不会被标成跨域', () => {
        const text = buildFetchFailureDetail({
            url: 'https://sullyos.example.com/api/x',
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://sullyos.example.com',
            pageProtocol: 'https:',
        }, { perf: { getEntriesByName: () => [] } });
        expect(text).toContain('同源');
        expect(text).not.toContain('跨域请求');
    });

    it('混合内容给的是「改成 https」而不是「查梯子」', () => {
        const text = buildFetchFailureDetail({
            url: 'http://my-bridge.example.com/api/health',
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://sullyos.example.com',
            pageProtocol: 'https:',
        }, { perf: { getEntriesByName: () => [] } });
        expect(text).toContain('混合内容');
        expect(text).not.toContain('DNS 解析不到');
    });

    it('Resource Timing 里有状态码时，直接点破「不是网络不通」', () => {
        const text = buildFetchFailureDetail({
            url: 'https://sullymeow.ccwu.cc/api/health',
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://sullyos.example.com',
            pageProtocol: 'https:',
        }, {
            perf: { getEntriesByName: () => [{ responseStatus: 429, transferSize: 0, duration: 120 }] },
        });
        expect(text).toContain('responseStatus=429');
        expect(text).toContain('CORS');
    });
});

describe('readResourceTimingHint', () => {
    it('没有记录时说明「连接可能压根没建立」', () => {
        expect(readResourceTimingHint('https://a.example.com/x', { getEntriesByName: () => [] }))
            .toContain('没有这条请求的记录');
    });

    it('取最后一条记录（同一 URL 重试过多次）', () => {
        const hint = readResourceTimingHint('https://a.example.com/x', {
            getEntriesByName: () => [{ responseStatus: 200 }, { responseStatus: 503 }],
        });
        expect(hint).toContain('503');
    });

    it('performance 不可用时静默返回空串，不能抛', () => {
        expect(readResourceTimingHint('https://a.example.com/x', {})).toBe('');
        expect(readResourceTimingHint('https://a.example.com/x', {
            getEntriesByName: () => { throw new Error('boom'); },
        })).toBe('');
    });
});

describe('probeOriginReachability', () => {
    beforeEach(() => resetReachabilityProbeCooldown());

    it('打的是域名根路径，不是原地址——原地址可能有副作用', async () => {
        const seen: any[] = [];
        const fakeFetch = ((url: any, init: any) => { seen.push([url, init]); return Promise.resolve(new Response('')); }) as any;
        const verdict = await probeOriginReachability('https://sullymeow.ccwu.cc/api/publish', fakeFetch);
        expect(verdict).toBe('reachable');
        expect(seen[0][0]).toBe('https://sullymeow.ccwu.cc/');
        expect(seen[0][1].mode).toBe('no-cors');
        expect(seen[0][1].credentials).toBe('omit');
    });

    it('探测也失败 → unreachable', async () => {
        const fakeFetch = (() => Promise.reject(failedToFetch())) as any;
        expect(await probeOriginReachability('https://sullymeow.ccwu.cc/api/health', fakeFetch)).toBe('unreachable');
    });

    it('被超时控制器掐断 → timeout，不是 unreachable', async () => {
        const fakeFetch = (() => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
        }) as any;
        expect(await probeOriginReachability('https://sullymeow.ccwu.cc/api/health', fakeFetch)).toBe('timeout');
    });

    it('同一域名 30s 内只探一次', async () => {
        let calls = 0;
        const fakeFetch = (() => { calls += 1; return Promise.resolve(new Response('')); }) as any;
        const now = () => 1_000_000;
        expect(await probeOriginReachability('https://a.example.com/1', fakeFetch, { now })).toBe('reachable');
        expect(await probeOriginReachability('https://a.example.com/2', fakeFetch, { now })).toBe('skipped');
        expect(calls).toBe(1);
        // 换个域名不受上一个的冷却影响
        expect(await probeOriginReachability('https://b.example.com/1', fakeFetch, { now })).toBe('reachable');
        expect(calls).toBe(2);
    });

    it('地址非法直接跳过，不浪费一次请求', async () => {
        let calls = 0;
        const fakeFetch = (() => { calls += 1; return Promise.resolve(new Response('')); }) as any;
        expect(await probeOriginReachability('not a url', fakeFetch)).toBe('skipped');
        expect(calls).toBe(0);
    });
});

describe('describeReachabilityProbe', () => {
    it('通了 → 指向 CORS/限流，明确说「网络路径是通的」', () => {
        const text = describeReachabilityProbe('reachable', 'sullymeow.ccwu.cc');
        expect(text).toContain('网络路径是通的');
        expect(text).toContain('CORS');
        expect(text).not.toContain('梯子的分流规则');
    });

    it('没通 → 指向线路，不能再提 CORS 把人带偏', () => {
        const text = describeReachabilityProbe('unreachable', 'sullymeow.ccwu.cc');
        expect(text).toContain('连不上');
        expect(text).toContain('梯子');
        expect(text).not.toContain('网络路径是通的');
    });

    it('skipped 不产出文案（不往日志里塞废话）', () => {
        expect(describeReachabilityProbe('skipped', 'a.example.com')).toBe('');
    });
});

describe('parseTargetUrl / 自查清单', () => {
    it('相对地址按 base 解析', () => {
        expect(parseTargetUrl('/api/health', 'https://sullyos.example.com/index.html').host).toBe('sullyos.example.com');
    });

    it('自查清单第一步就是「换节点 / 关梯子直连」', () => {
        expect(NETWORK_SELF_CHECK_STEPS.length).toBeGreaterThanOrEqual(4);
        expect(NETWORK_SELF_CHECK_STEPS[0]).toContain('梯子');
    });
});
