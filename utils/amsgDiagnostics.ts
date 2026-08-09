// 主动消息 2.0 的「体检」判定：把 worker 的 GET /debug 回执翻成一排能直接看的结论，
// 以及把 fetch 抛出来的异常翻成一句知道该去改哪儿的话。
//
// 单独成叶子的原因有两个：
//   1. 这两件事都是纯函数（输入回执 / 异常，输出结论），能脱开浏览器单测，而它们要
//      守的恰恰是「坏了但界面看不出来」这一类问题——没有测试钉住，退化了没人会发现。
//   2. activeMsgClient 要用它，设置面板也要用它，放在任何一边都会让另一边反向依赖。
//
// worker 那侧的对应实现见 worker/amsg/src/index.ts 的 inspectWorkerEnv / inspectStorage /
// judgeTick，改动那三处的输出形状时这份要跟着走。

// ─── 失败归类（给使用统计分档用）───
//
// 「连接失败」在图上只有一格的话，地址填错、密钥对不上、D1 没绑、纯断网会长成一个样，
// 而这四种要修的引导完全不同。所以在**抛错的那一刻**按源码里写死的谓词挂一个代号，
// 上报只带这个代号。
//
// 报错原文（可能带 Worker 地址、push endpoint）一个字都不进上报——挂在这里的
// 永远是下面这个联合类型里的字面量之一，不是从异常对象上读出来的任何东西。
// 见 docs/analytics.md 「加新埋点的规矩」第 4 条。
export type AmsgFailKind =
  | '地址没填'
  | '打到网页了'
  | '鉴权失败'
  | '端点不存在'
  | '建表失败'
  | '配置缺失'
  | '网络失败'
  | '权限被拒'
  | '不支持推送'
  | 'worker没配VAPID'
  | '订阅失败'
  | '推送通道不通'
  | '端点僵尸'
  | '其他';

/** 从 Worker 地址里取一个能给人看的域名。取不到（没填 / 填了段不是 URL 的东西）返回空串。 */
export const readWorkerHost = (workerUrl: string | null | undefined): string => {
  const value = workerUrl?.trim();
  if (!value) return '';
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
};

const looksLikeHtmlFallbackError = (message: string) => (
  /HTML/i.test(message) ||
  message.includes(`Unexpected token '<'`) ||
  /<!doctype/i.test(message) ||
  /<html/i.test(message)
);

/**
 * 浏览器把「连不上」报成什么，各家不一样：Chrome/Firefox 是 TypeError: Failed to fetch，
 * Safari 是 TypeError: Load failed，旧 Firefox 还有 NetworkError when attempting to fetch。
 * 三种都得认，漏一种就有一批人只能看到光秃秃的英文。
 */
const looksLikeOfflineError = (message: string, name: string) => (
  name === 'TypeError' ||
  /failed to fetch/i.test(message) ||
  /load failed/i.test(message) ||
  /networkerror/i.test(message)
);

const looksLikeTimeoutError = (message: string, name: string) => (
  name === 'AbortError' ||
  name === 'TimeoutError' ||
  /timed? ?out/i.test(message) ||
  /aborted/i.test(message)
);

export interface AmsgFetchFailureDescription {
  /** 直接显示给用户的整句，含「这是哪一步、坏在哪、去改哪儿」。可能多行。 */
  message: string;
  /** 上报用的代号，永远是 AmsgFailKind 里的字面量。 */
  kind: AmsgFailKind;
}

/**
 * 把 fetch 抛出来的异常翻成人话。
 *
 * 存在的理由：这类异常的原文只有 "Failed to fetch" 五个字，既不说打的是哪儿，也不说
 * 是网络不通还是地址错了。社区里排查这一句花掉过好几天——先怀疑代理平台封号、再怀疑
 * worker 配置、最后才发现只是当时没连上 Cloudflare。所以在这儿一次把三件事说全：
 * 是哪一步、连的是哪个域名、可能的原因分别去哪儿改。
 *
 * 另外必须写明「这条路不通不影响到点推送」：推送是 Cloudflare 直接发给设备的，
 * 跟浏览器能不能连上 worker 是两条路。不写的话用户会以为主动消息整个废了。
 */
export const describeAmsgFetchFailure = (
  error: unknown,
  phase: string,
  workerUrl?: string | null,
): AmsgFetchFailureDescription => {
  const raw = error instanceof Error ? error.message : String(error || 'Unknown error');
  const name = error instanceof Error ? error.name : '';
  const host = readWorkerHost(workerUrl);
  const where = host ? `（${host}）` : '';

  if (looksLikeHtmlFallbackError(raw)) {
    return {
      kind: '打到网页了',
      message: `主动消息 2.0 的${phase}请求没有打到 Worker${where}，而是拿到了一个网页。请确认设置里填的是你部署好的 amsg Worker 地址，不是某个网页地址。`,
    };
  }

  if (looksLikeTimeoutError(raw, name)) {
    return {
      kind: '网络失败',
      message: `主动消息 2.0 的${phase}请求等太久，超时了${where}。多半是当前网络到 Cloudflare 很慢或中途被掐断，稍后重试即可；一直这样的话，用设置面板里的「Deno 门面」换一条线路。\n到点的主动消息推送不走这条路，不受影响。`,
    };
  }

  if (looksLikeOfflineError(raw, name)) {
    return {
      kind: '网络失败',
      message: `连不上你的 Worker${where}，${phase}没能完成。\n这一步是这台设备直接去连 Cloudflare，常见原因有三个：当前网络到 Cloudflare 不通（换个网络，或用设置面板里的「Deno 门面」套一层）、Worker 地址填错了、Worker 已经被删掉了。\n到点的主动消息推送是 Cloudflare 直接发给设备的，不走这条路，所以照常收得到。`,
    };
  }

  return { kind: '其他', message: `主动消息 2.0 的${phase}请求失败：${raw}` };
};

// ─── /debug 回执 → 一排看得懂的结论 ───

/** worker 自检里「能跑但有一块是哑的」那类提醒。 */
export interface AmsgConfigWarning { code: string; message: string }

/** GET /debug 回执里用得上的那部分（worker/amsg/src/index.ts）。 */
export interface AmsgDebugReport {
  config: { ok: boolean; missing: string[]; message: string; warnings: AmsgConfigWarning[] };
  storage: {
    reachable: boolean;
    schemaReady?: boolean;
    missingTables?: string[];
    missingColumns?: string[];
    pushSubscriptionRegistered?: boolean;
    pendingTasks?: number;
    overdueTasks?: number;
    oldestOverdueMinutes?: number | null;
    error?: string;
  };
  /** cron 在不在按时处理任务。unknown = 手上没有待发任务，无从判断。 */
  tick: 'unknown' | 'idle' | 'healthy' | 'stalled';
  server: { version: string | null; featureCount: number } | null;
  vapidPublicKey: string | null;
}

/**
 * 认一份 /debug 回执，形状对不上返回 null。
 *
 * 宽容不了的地方在于：没有这个端点的 worker 回什么的都有（404 的 JSON、Cloudflare 的
 * 错误页、代理塞回来的一段 HTML）。只看 success 就采信的话，会把一台好 worker 判成
 * 「哪儿都是红的」——那比不体检还糟，用户照着提示改哪儿都改不对。
 */
export const parseAmsgDebugReport = (body: unknown): AmsgDebugReport | null => {
  const data = (body as { success?: unknown; data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== 'object') return null;
  const config = data.config;
  const storage = data.storage;
  if (typeof config?.ok !== 'boolean' || !Array.isArray(config.missing)) return null;
  if (typeof storage?.reachable !== 'boolean') return null;

  return {
    config: {
      ok: config.ok,
      missing: config.missing.filter((item: unknown): item is string => typeof item === 'string'),
      message: typeof config.message === 'string' ? config.message : '',
      warnings: Array.isArray(config.warnings)
        ? config.warnings.filter((item: any) => typeof item?.code === 'string' && typeof item?.message === 'string')
        : [],
    },
    storage,
    tick: ['idle', 'healthy', 'stalled'].includes(data.tick) ? data.tick : 'unknown',
    server: data.server && typeof data.server === 'object'
      ? { version: data.server.version ?? null, featureCount: Number(data.server.featureCount) || 0 }
      : null,
    vapidPublicKey: typeof data.vapidPublicKey === 'string' ? data.vapidPublicKey : null,
  };
};

/** 一行体检结论的严重程度。bad = 现在就是坏的，warn = 能跑但有一块是哑的。 */
export type AmsgDiagnosticLevel = 'ok' | 'warn' | 'bad' | 'unknown';

export interface AmsgDiagnosticRow {
  key: string;
  label: string;
  level: AmsgDiagnosticLevel;
  /** 一句话：坏在哪、去哪儿改。ok 的行写现状即可。 */
  detail: string;
}

/** 拉体检的结果。连不上时带上已经翻成人话的原因，那本身就是第一行结论。 */
export type AmsgDiagnosticsProbe =
  | { reachable: true; report: AmsgDebugReport }
  | { reachable: false; reason: string; /** 旧 worker 没有这个端点，不是坏了 */ unsupported?: boolean };

export interface AmsgDiagnosticsInput {
  probe: AmsgDiagnosticsProbe;
  /** 这台设备的浏览器有没有推送订阅（本地事实，worker 那侧看不到）。 */
  localPushSubscribed?: boolean;
}

const DB_MISSING_HINT = 'Worker 没有绑定 D1 数据库。多半是部署第一步填完 Database ID 之后没点那个「Add」就直接 Deploy 了。回 Cloudflare 的 Settings → Bindings 加一条 D1 database，变量名填大写的 DB。';
const MASTER_KEY_MISSING_HINT = 'Worker 上没有 AMSG_MASTER_KEY。去 Settings → Variables and secrets 添加，类型一定要选 Secret——选成 Text 的话下次部署就会消失。';
const SCHEMA_STALE_HINT = '换过 Worker 版本后，已经存在的表不会自己长出新列，定时任务每分钟都会因为读不到它们而挂掉（界面上一切正常，就是一条都不发）。点上面的「重新连接并验证」补一次。';

/**
 * 把体检结果排成一列，顺序就是「该先修哪个」。
 *
 * 每一行只回答一个问题，且都是靠自己能改的：连不连得上 → 库绑没绑 → 密钥有没有 →
 * 表建没建全 → 推送凭据配没配 → 这台设备登记了没 → 定时任务在不在跑。
 * 前面的行是坏的时候，后面那些查不出结论的一律报 unknown，不假装绿。
 */
export const buildAmsgDiagnosticRows = (input: AmsgDiagnosticsInput): AmsgDiagnosticRow[] => {
  const { probe, localPushSubscribed } = input;

  if (!probe.reachable) {
    const unknownRest = (key: string, label: string): AmsgDiagnosticRow => ({
      key, label, level: 'unknown', detail: '连上 Worker 之后才能查。',
    });
    return [
      {
        key: 'reachable',
        label: 'Worker 可达',
        level: probe.unsupported ? 'warn' : 'bad',
        detail: probe.reason,
      },
      unknownRest('database', '数据库绑定'),
      unknownRest('masterKey', '主密钥'),
      unknownRest('schema', '数据表'),
      unknownRest('pushCredential', '推送凭据'),
      unknownRest('pushDevice', '这台设备'),
      unknownRest('tick', '定时任务'),
    ];
  }

  const { config, storage, tick } = probe.report;
  const rows: AmsgDiagnosticRow[] = [];

  rows.push({
    key: 'reachable',
    label: 'Worker 可达',
    level: 'ok',
    detail: probe.report.server?.version ? `后端版本 ${probe.report.server.version}` : '连得上。',
  });

  const dbMissing = config.missing.includes('DB');
  rows.push({
    key: 'database',
    label: '数据库绑定',
    level: dbMissing ? 'bad' : 'ok',
    detail: dbMissing ? DB_MISSING_HINT : '已绑定 D1。',
  });

  const masterKeyMissing = config.missing.includes('AMSG_MASTER_KEY');
  const masterKeyFormat = config.warnings.find((item) => item.code === 'MASTER_KEY_FORMAT');
  rows.push({
    key: 'masterKey',
    label: '主密钥',
    level: masterKeyMissing ? 'bad' : masterKeyFormat ? 'warn' : 'ok',
    detail: masterKeyMissing ? MASTER_KEY_MISSING_HINT : masterKeyFormat?.message || '已配置。',
  });

  // 库都没绑的话，下面这些查出来必然是「什么都没有」，报红会把人往错的方向引。
  if (dbMissing || !storage.reachable) {
    rows.push({
      key: 'schema',
      label: '数据表',
      level: dbMissing ? 'unknown' : 'bad',
      detail: dbMissing
        ? '先把 D1 绑上再看这一项。'
        : `连得上 Worker，但读不了它的数据库${storage.error ? `（${storage.error}）` : ''}。`,
    });
  } else {
    const missingTables = storage.missingTables || [];
    const missingColumns = storage.missingColumns || [];
    const schemaBad = missingTables.length > 0 || missingColumns.length > 0;
    rows.push({
      key: 'schema',
      label: '数据表',
      level: schemaBad ? 'bad' : 'ok',
      detail: missingTables.length
        ? `缺表：${missingTables.join('、')}。点上面的「重新连接并验证」会自动建好（可能要点两次）。`
        : missingColumns.length
          ? `表结构是旧的，缺列：${missingColumns.join('、')}。${SCHEMA_STALE_HINT}`
          : '表和列都齐了。',
    });
  }

  const vapidWarning = config.warnings.find((item) => item.code === 'VAPID_MISSING');
  rows.push({
    key: 'pushCredential',
    label: '推送凭据',
    level: vapidWarning ? 'bad' : 'ok',
    // 这是最难自己查出来的一种坏法：任务建得成、界面全绿，到点一条都推不出去。
    detail: vapidWarning ? vapidWarning.message : 'VAPID 已配齐。',
  });

  const remoteRegistered = storage.pushSubscriptionRegistered === true;
  rows.push({
    key: 'pushDevice',
    label: '这台设备',
    level: !localPushSubscribed ? 'bad' : remoteRegistered ? 'ok' : 'bad',
    detail: !localPushSubscribed
      ? '这台设备还没订阅推送，点下面的「开启通知与推送」。'
      : remoteRegistered
        ? '浏览器已订阅，Worker 上也登记了收件设备。换设备或换浏览器之后要在新的那台上再点一次「开启通知与推送」。'
        : '浏览器订阅好了，但 Worker 上没有登记收件设备——到点的消息发不出去。点下面的「开启通知与推送」补登记一次。',
  });

  const overdue = storage.overdueTasks || 0;
  const stalledMinutes = storage.oldestOverdueMinutes ?? null;
  rows.push({
    key: 'tick',
    label: '定时任务',
    level: tick === 'stalled' ? 'bad' : tick === 'unknown' ? 'unknown' : 'ok',
    detail: tick === 'stalled'
      ? `有 ${overdue} 条任务到点${stalledMinutes === null ? '' : ` ${stalledMinutes} 分钟`}还没发出去。定时触发器可能没在跑，或者每分钟那一跳在报错——去 Cloudflare 的 Workers → 你的 Worker → Observability 看日志。`
      : tick === 'healthy'
        ? `${storage.pendingTasks ?? 0} 条待发任务，都在按时处理。`
        : tick === 'idle'
          ? '现在没有待发任务。'
          : '手上没有待发任务，暂时看不出定时器在不在跑。',
  });

  return rows;
};

/** 一排结论里最严重的那一档，用来给面板定基调。 */
export const summarizeAmsgDiagnostics = (rows: AmsgDiagnosticRow[]): AmsgDiagnosticLevel => {
  if (rows.some((row) => row.level === 'bad')) return 'bad';
  if (rows.some((row) => row.level === 'warn')) return 'warn';
  if (rows.some((row) => row.level === 'unknown')) return 'unknown';
  return 'ok';
};
