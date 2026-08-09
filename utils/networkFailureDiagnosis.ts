// 全局 fetch 拦截器（context/OSContext.tsx）抓到「请求压根没拿到响应」时，把浏览器那句
// 光秃秃的 `TypeError: Failed to fetch` 翻成一条能照着排查的日志。
//
// 为什么值得单开一份：
//   1. 浏览器出于安全，把「DNS 解析不了」「梯子把连接掐了」「扩展屏蔽了」「对方返回的
//      响应没有 CORS 头」这四件完全不同的事，统统报成同一句 Failed to fetch，不带任何
//      细节。用户把日志复制出来发到群里，信息量是零——这份文件的活就是把能补的旁证
//      （耗时、在线状态、是否跨域、Resource Timing 里那条记录）全补上，再给一句初判。
//   2. 其中最关键的一条旁证是「换 no-cors 再打一次这个域名」：no-cors 不做 CORS 校验，
//      只要网络路径通就会拿到一个 opaque 响应。它成功而原请求失败 ⇒ 网络没问题，是响应
//      头/CORS 的事（多半是对方挡在 Cloudflare 限流页或人机验证页后面）；它也失败 ⇒ 这台
//      设备到这个域名是真的不通，该去查梯子规则 / DNS / 防火墙 / 扩展。这一刀把排查范围
//      直接砍掉一半，是整份文件存在的理由。
//   3. 判定全是纯函数，能脱开浏览器单测；探测那部分把 fetch 当参数传进来，测试塞假的。
//
// ⚠️ 探测必须用**未被拦截的原生 fetch**（拦截器里的 originalFetch），否则探测自己失败会
// 再写一条日志，一条网络错误滚成一屏。

/** 连接失败的粗分类。用于选那句初判，也用于决定要不要做 no-cors 复检。 */
export type FetchFailureKind =
    | 'aborted'        // 调用方主动取消 / 超时控制器掐的
    | 'offline'        // navigator.onLine === false，浏览器自己知道没网
    | 'mixed-content'  // https 页面打 http 地址，被浏览器直接拦
    | 'bad-url'        // 地址本身就不合法（拼错、少了协议头）
    | 'blocked'        // 拿不到响应：代理/DNS/扩展/CORS 四选一，靠复检再分
    | 'unknown';

export interface FetchFailureContext {
    url: string;
    /** 请求方法，取不到按 GET 记。 */
    method?: string;
    /** 从发起到抛错的毫秒数。 */
    durationMs?: number;
    error?: unknown;
    /** 以下三项默认读全局，测试里显式传。 */
    online?: boolean;
    pageOrigin?: string;
    pageProtocol?: string;
}

const readError = (error: unknown): { name: string; message: string } => {
    if (error instanceof Error) return { name: error.name || 'Error', message: error.message || String(error) };
    if (error && typeof error === 'object') {
        const anyErr = error as { name?: unknown; message?: unknown };
        return {
            name: typeof anyErr.name === 'string' ? anyErr.name : 'Error',
            message: typeof anyErr.message === 'string' ? anyErr.message : String(error),
        };
    }
    return { name: 'Error', message: String(error ?? '') };
};

/**
 * 各家浏览器对「连不上」的说法不一样，漏认一种就会掉进 unknown：
 * Chrome/Edge 是 Failed to fetch，Safari 是 Load failed，Firefox 是
 * NetworkError when attempting to fetch resource。
 */
const looksLikeNetworkError = (message: string) => (
    /failed to fetch/i.test(message)
    || /load failed/i.test(message)
    || /networkerror/i.test(message)
    || /network request failed/i.test(message)
);

/** 把 URL 拆成 origin/host，拆不动（相对路径、拼错）时用当前页面兜底。 */
export const parseTargetUrl = (url: string, base?: string): { ok: boolean; origin: string; host: string; protocol: string; href: string } => {
    try {
        const parsed = new URL(url, base || (typeof location !== 'undefined' ? location.href : undefined));
        return { ok: true, origin: parsed.origin, host: parsed.host, protocol: parsed.protocol, href: parsed.href };
    } catch {
        return { ok: false, origin: '', host: '', protocol: '', href: url };
    }
};

/** http://localhost / 127.0.0.1 在 Chrome 里算可信来源，不当混合内容拦；Firefox 会拦。 */
const isLoopbackHost = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);

export const classifyFetchFailure = (ctx: FetchFailureContext): FetchFailureKind => {
    const { name, message } = readError(ctx.error);
    if (name === 'AbortError' || /aborted|abort/i.test(message)) return 'aborted';

    const target = parseTargetUrl(ctx.url);
    if (!target.ok) return 'bad-url';

    const pageProtocol = ctx.pageProtocol ?? (typeof location !== 'undefined' ? location.protocol : '');
    if (pageProtocol === 'https:' && target.protocol === 'http:' && !isLoopbackHost(target.host)) return 'mixed-content';

    const online = ctx.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
    if (online === false) return 'offline';

    if (looksLikeNetworkError(message) || name === 'TypeError') return 'blocked';
    return 'unknown';
};

/** 每种分类给一句「现在能确定什么」+ 一行「可能是什么」。 */
const VERDICTS: Record<FetchFailureKind, { verdict: string; causes: string }> = {
    aborted: {
        verdict: '请求被主动取消（超时控制器掐的，或页面/组件卸载了）。',
        causes: '对方响应太慢超过了超时阈值 · 中途切走了页面 · 手动点了停止',
    },
    offline: {
        verdict: '浏览器自己报告当前离线，请求根本没发出去。',
        causes: '网络断了 · 梯子刚切换/掉线 · 设备进了飞行模式',
    },
    'mixed-content': {
        verdict: 'https 页面去打 http 地址，被浏览器的混合内容策略直接拦下，请求没有发出去。',
        causes: '地址少了 s（http:// 应为 https://） · 自建服务没配证书',
    },
    'bad-url': {
        verdict: '这个地址本身不是合法 URL，请求没有发出去。',
        causes: '地址填错/少了 https:// · 复制时带进了空格或中文引号',
    },
    blocked: {
        verdict: '请求在拿到响应头之前就失败了——浏览器没告诉我们具体是哪一步断的。',
        causes: '梯子/代理把这个域名的连接掐了 · DNS 解析不到 · 浏览器扩展（广告拦截/隐私盾/脚本管理器）屏蔽了 · 对方返回的是一张不带 CORS 头的页面（限流、人机验证、网关报错）',
    },
    unknown: {
        verdict: '请求失败，且不符合已知的几种失败形态。',
        causes: '看下面的错误原文',
    },
};

/** Resource Timing 里那条记录能补两个关键旁证：到底有没有收到响应状态码、传了多少字节。 */
export const readResourceTimingHint = (
    href: string,
    perf?: { getEntriesByName?: (name: string, type?: string) => any[] },
): string => {
    const target = perf ?? (typeof performance !== 'undefined' ? (performance as any) : undefined);
    if (!target?.getEntriesByName) return '';
    let entries: any[] = [];
    try {
        entries = target.getEntriesByName(href, 'resource') || [];
    } catch {
        return '';
    }
    const entry = entries[entries.length - 1];
    if (!entry) return 'Resource Timing: 没有这条请求的记录（通常说明连接压根没建立起来，或被扩展在发出前就拦掉了）';
    const parts: string[] = [];
    if (typeof entry.responseStatus === 'number') parts.push(`responseStatus=${entry.responseStatus}`);
    if (typeof entry.transferSize === 'number') parts.push(`transferSize=${entry.transferSize}`);
    if (typeof entry.duration === 'number') parts.push(`duration=${Math.round(entry.duration)}ms`);
    let note = '';
    if (typeof entry.responseStatus === 'number' && entry.responseStatus > 0) {
        note = ` → 对方其实回了 HTTP ${entry.responseStatus}，是响应被 CORS 拦掉的，不是网络不通`;
    }
    return `Resource Timing: ${parts.join(', ') || '有记录'}${note}`;
};

/**
 * 拼出写进调试终端 detail 的那一段。同步、无副作用——no-cors 复检结论由
 * describeReachabilityProbe() 单独产出，异步补到这段后面。
 */
export const buildFetchFailureDetail = (
    ctx: FetchFailureContext,
    opts?: { perf?: { getEntriesByName?: (name: string, type?: string) => any[] } },
): string => {
    const { name, message } = readError(ctx.error);
    const kind = classifyFetchFailure(ctx);
    const target = parseTargetUrl(ctx.url);
    const pageOrigin = ctx.pageOrigin ?? (typeof location !== 'undefined' ? location.origin : '');
    const online = ctx.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
    const method = (ctx.method || 'GET').toUpperCase();

    const lines: string[] = [];
    lines.push(`URL: ${ctx.url}`);
    const durationText = typeof ctx.durationMs === 'number' ? ` · 失败于 ${ctx.durationMs}ms` : '';
    lines.push(`请求: ${method}${durationText}`);
    lines.push(`错误: ${name}: ${message}`);
    if (target.ok) {
        const crossOrigin = pageOrigin && target.origin !== pageOrigin;
        lines.push(`目标域名: ${target.host}${crossOrigin ? '（跨域请求，受 CORS 约束）' : '（同源）'}`);
    }
    if (pageOrigin) lines.push(`本页来源: ${pageOrigin}`);
    lines.push(`浏览器联网状态: ${online === false ? '离线' : '在线'}`);
    const timing = readResourceTimingHint(target.href, opts?.perf);
    if (timing) lines.push(timing);
    lines.push(`初判: ${VERDICTS[kind].verdict}`);
    lines.push(`可能原因: ${VERDICTS[kind].causes}`);
    return lines.join('\n');
};

// ─── no-cors 连通性复检 ───

export type ReachabilityVerdict = 'reachable' | 'unreachable' | 'timeout' | 'skipped';

/** 同一个域名 30s 内只复检一次，避免一串请求同时炸时打出一片探测流量。 */
const probeCooldown = new Map<string, number>();
const PROBE_COOLDOWN_MS = 30_000;

export const resetReachabilityProbeCooldown = () => probeCooldown.clear();

/**
 * 用 no-cors 打一次目标域名的根路径，只为回答一个问题：这台设备到底能不能碰到这个域名。
 *
 * - 打根路径而不是原地址：原地址可能是有副作用的接口（下单、发消息），复检不该顺手触发它；
 *   而 DNS / 梯子 / 防火墙 / 扩展这几层拦的都是整个域名，打根路径一样能测出来。
 * - no-cors 拿到的是 opaque 响应，读不出状态码——但「拿到了」本身就是结论。
 */
export const probeOriginReachability = async (
    url: string,
    fetchImpl: typeof fetch,
    opts?: { timeoutMs?: number; now?: () => number },
): Promise<ReachabilityVerdict> => {
    const target = parseTargetUrl(url);
    if (!target.ok || !target.origin || target.origin === 'null') return 'skipped';

    const now = opts?.now ?? (() => Date.now());
    const last = probeCooldown.get(target.origin);
    const at = now();
    if (typeof last === 'number' && at - last < PROBE_COOLDOWN_MS) return 'skipped';
    probeCooldown.set(target.origin, at);

    const timeoutMs = opts?.timeoutMs ?? 6000;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
        await fetchImpl(`${target.origin}/`, {
            method: 'GET',
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'follow',
            signal: controller?.signal,
        });
        return 'reachable';
    } catch (e) {
        const { name } = readError(e);
        return name === 'AbortError' ? 'timeout' : 'unreachable';
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

/** 把复检结论翻成给人看的一句话 + 下一步该往哪查。 */
export const describeReachabilityProbe = (verdict: ReachabilityVerdict, host: string): string => {
    const who = host || '该域名';
    switch (verdict) {
        case 'reachable':
            return `连通性复检: no-cors 直连 ${who} 成功 → 网络路径是通的，问题出在响应本身（对方没回 CORS 头，多半是限流页 / 人机验证页 / 网关错误页）。换个网络或过几分钟重试，仍旧的话把这条日志发给作者。`;
        case 'unreachable':
            return `连通性复检: no-cors 直连 ${who} 同样失败 → 这台设备到 ${who} 是真的连不上。按顺序查：梯子的分流规则（把该域名放进代理）、DNS、浏览器扩展（广告拦截/隐私盾）、系统或路由器防火墙。`;
        case 'timeout':
            return `连通性复检: no-cors 直连 ${who} 超时（连接挂住不返回）→ 多半是代理/网关把连接吞了，或对方正被限速。优先换一个梯子节点再试。`;
        default:
            return '';
    }
};

/** 给调试终端用的通用自查清单——网络类错误一律先照这个走一遍。 */
export const NETWORK_SELF_CHECK_STEPS: string[] = [
    '换一个梯子节点，或先关掉梯子直连试一次——两种都失败才说明不是线路问题',
    '把浏览器扩展（广告拦截、隐私盾、脚本管理器）全禁掉再试，或换用无痕窗口',
    '在新标签页直接打开日志里那个 URL：能出 JSON 说明网络通，是页面这边的跨域被拦；打不开就是线路/DNS 的事',
    '换一个浏览器或换手机热点各试一次，能定位到是「这台设备」还是「这个网络」',
    '如果只有部分功能报错，去设置里看对应的服务地址是不是填错了（少 https://、多空格、多结尾斜杠）',
];
