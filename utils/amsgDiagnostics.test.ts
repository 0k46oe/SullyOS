// utils/amsgDiagnostics.test.ts
// 回归守卫：
//   1. fetch 失败不能再把 "Failed to fetch" 原样丢给用户——必须说出连的是哪个域名、
//      可能的三个原因，以及「到点推送不走这条路」。社区里排查这一句花掉过好几天。
//   2. 各家浏览器报「连不上」的说法不一样（Chrome 的 Failed to fetch、Safari 的
//      Load failed、旧 Firefox 的 NetworkError），漏认一种就有一批人只剩英文原文。
//   3. 体检面板的红绿判定：缺 D1 绑定、表结构是旧的、VAPID 没配、云端没登记收件设备，
//      这四种都是「界面上一切正常、就是一条都不发」，必须各自单独报出来。
//   4. 连不上 / 回执形状不对时，其余各项一律 unknown，不许假装绿——那比不体检更糟，
//      用户会照着绿灯去别处瞎找。
import { describe, it, expect } from 'vitest';
import {
  AmsgDebugReport,
  buildAmsgDiagnosticRows,
  describeAmsgFetchFailure,
  parseAmsgDebugReport,
  readWorkerHost,
  summarizeAmsgDiagnostics,
} from './amsgDiagnostics';

const WORKER_URL = 'https://amsg.example.workers.dev';

const rowOf = (rows: ReturnType<typeof buildAmsgDiagnosticRows>, key: string) => {
  const row = rows.find((item) => item.key === key);
  if (!row) throw new Error(`体检结果里没有 ${key} 这一行`);
  return row;
};

/** 一份全绿的回执，各用例只改自己要考的那一处。 */
const healthyReport = (patch: Partial<AmsgDebugReport> = {}): AmsgDebugReport => ({
  config: { ok: true, missing: [], message: 'Worker 配置齐全。', warnings: [] },
  storage: {
    reachable: true,
    schemaReady: true,
    missingTables: [],
    missingColumns: [],
    pushSubscriptionRegistered: true,
    pendingTasks: 2,
    overdueTasks: 0,
    oldestOverdueMinutes: null,
  },
  tick: 'healthy',
  server: { version: '2.6.0-next.15', featureCount: 27 },
  vapidPublicKey: 'BNPtv_1egsDlvOIk',
  ...patch,
});

describe('describeAmsgFetchFailure — 把 fetch 异常翻成人话', () => {
  it('连不上时说清域名、三个可能原因，以及推送不受影响', () => {
    const { message, kind } = describeAmsgFetchFailure(
      Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }),
      '初始化数据库',
      WORKER_URL,
    );

    expect(kind).toBe('网络失败');
    // 域名：不说打的是哪儿，用户没法判断是自己网络的问题还是地址填错了。
    expect(message).toContain('amsg.example.workers.dev');
    expect(message).toContain('连不上');
    // 三条自查线索都要在，缺一条就会有人往错的方向翻。
    expect(message).toContain('Deno');
    expect(message).toContain('地址填错');
    // 最要紧的一句：别让用户以为主动消息整个废了。
    expect(message).toContain('推送');
    expect(message).toMatch(/不走这条路|不受影响/);
    // 光秃秃的英文原文不该是用户看到的全部。
    expect(message).not.toBe('Failed to fetch');
  });

  it('Safari 的 Load failed 和旧 Firefox 的 NetworkError 同样认得出来', () => {
    const safari = describeAmsgFetchFailure(new TypeError('Load failed'), '读取任务列表', WORKER_URL);
    const firefox = describeAmsgFetchFailure(
      Object.assign(new Error('NetworkError when attempting to fetch resource.'), { name: 'NetworkError' }),
      '读取任务列表',
      WORKER_URL,
    );

    for (const result of [safari, firefox]) {
      expect(result.kind).toBe('网络失败');
      expect(result.message).toContain('连不上');
    }
  });

  it('超时单独成一句：这是「慢」不是「不通」，处理办法不一样', () => {
    const { message, kind } = describeAmsgFetchFailure(
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
      '即时对话',
      WORKER_URL,
    );

    expect(kind).toBe('网络失败');
    expect(message).toContain('超时');
    expect(message).toContain('amsg.example.workers.dev');
  });

  it('打到网页上（拿回 HTML）仍然单独归类，指去检查地址', () => {
    const { message, kind } = describeAmsgFetchFailure(
      new Error(`Unexpected token '<', "<!doctype ..." is not valid JSON`),
      '配置自检',
      WORKER_URL,
    );

    expect(kind).toBe('打到网页了');
    expect(message).toContain('网页');
  });

  it('没填地址时不硬凑域名，也不把 undefined 印出来', () => {
    const { message } = describeAmsgFetchFailure(new TypeError('Failed to fetch'), '初始化数据库', '');
    expect(message).not.toContain('undefined');
    expect(message).not.toContain('（）');
  });

  it('认不出来的异常保留原文，不吞成一句「网络错误」', () => {
    const { message, kind } = describeAmsgFetchFailure(new Error('AES-GCM decrypt failed'), '读取云端状态', WORKER_URL);
    expect(kind).toBe('其他');
    expect(message).toContain('AES-GCM decrypt failed');
  });
});

describe('readWorkerHost', () => {
  it('取域名，取不到就返回空串', () => {
    expect(readWorkerHost('https://amsg.example.workers.dev/')).toBe('amsg.example.workers.dev');
    expect(readWorkerHost('  ')).toBe('');
    expect(readWorkerHost('不是个地址')).toBe('');
    expect(readWorkerHost(undefined)).toBe('');
  });
});

describe('parseAmsgDebugReport — 只认形状对得上的回执', () => {
  it('认得出正常回执', () => {
    const parsed = parseAmsgDebugReport({ success: true, data: healthyReport() });
    expect(parsed?.config.ok).toBe(true);
    expect(parsed?.tick).toBe('healthy');
    expect(parsed?.server?.version).toBe('2.6.0-next.15');
  });

  it('旧 worker 回的 404 / 代理塞回来的 HTML 一律判成「没有这个端点」，不当成体检结果', () => {
    expect(parseAmsgDebugReport({ success: false, error: { code: 'NOT_FOUND' } })).toBeNull();
    expect(parseAmsgDebugReport('<!doctype html><html></html>')).toBeNull();
    expect(parseAmsgDebugReport(null)).toBeNull();
    // 有 data 但缺关键字段的，同样不采信。
    expect(parseAmsgDebugReport({ success: true, data: { config: {} } })).toBeNull();
  });

  it('tick 是没见过的值时退回 unknown，不原样透出去', () => {
    const parsed = parseAmsgDebugReport({ success: true, data: healthyReport({ tick: 'wat' as any }) });
    expect(parsed?.tick).toBe('unknown');
  });
});

describe('buildAmsgDiagnosticRows — 红绿判定', () => {
  it('全绿时每一行都是 ok', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: healthyReport() },
      localPushSubscribed: true,
    });
    expect(rows.every((row) => row.level === 'ok')).toBe(true);
    expect(summarizeAmsgDiagnostics(rows)).toBe('ok');
  });

  it('连不上时其余各项是 unknown，不假装绿', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: false, reason: '连不上你的 Worker（amsg.example.workers.dev）。' },
      localPushSubscribed: true,
    });

    expect(rowOf(rows, 'reachable').level).toBe('bad');
    expect(rowOf(rows, 'reachable').detail).toContain('连不上');
    expect(rows.filter((row) => row.key !== 'reachable').every((row) => row.level === 'unknown')).toBe(true);
    expect(rows.some((row) => row.level === 'ok')).toBe(false);
  });

  it('D1 没绑：点名是部署第一步漏点了 Add，且不再拿数据表报第二次红', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          config: { ok: false, missing: ['DB'], message: 'Worker 配置不完整', warnings: [] },
          storage: { reachable: false },
        }),
      },
      localPushSubscribed: true,
    });

    const database = rowOf(rows, 'database');
    expect(database.level).toBe('bad');
    expect(database.detail).toContain('Add');
    expect(database.detail).toContain('Bindings');
    expect(database.detail).toContain('DB');
    // 库没绑的时候表当然是空的，这一行跟着报红只会把人往错的方向引。
    expect(rowOf(rows, 'schema').level).toBe('unknown');
  });

  it('主密钥缺失时提醒类型要选 Secret（选成 Text 下次部署就没了）', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          config: { ok: false, missing: ['AMSG_MASTER_KEY'], message: '', warnings: [] },
        }),
      },
      localPushSubscribed: true,
    });

    const masterKey = rowOf(rows, 'masterKey');
    expect(masterKey.level).toBe('bad');
    expect(masterKey.detail).toContain('Secret');
  });

  it('表结构是旧的（缺列）要单独报红并指向「重新连接并验证」', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: false,
            missingTables: [],
            missingColumns: ['lease_until', 'retry_after'],
            pushSubscriptionRegistered: true,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const schema = rowOf(rows, 'schema');
    expect(schema.level).toBe('bad');
    expect(schema.detail).toContain('lease_until');
    expect(schema.detail).toContain('重新连接并验证');
  });

  it('缺表时说清点哪个按钮能自动建好', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: false,
            missingTables: ['scheduled_messages'],
            missingColumns: [],
            pushSubscriptionRegistered: false,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    expect(rowOf(rows, 'schema').detail).toContain('scheduled_messages');
    expect(rowOf(rows, 'schema').detail).toContain('重新连接并验证');
  });

  it('VAPID 没配齐要报红：任务建得成，到点一条都推不出去', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          config: {
            ok: true,
            missing: [],
            message: '',
            warnings: [{ code: 'VAPID_MISSING', message: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 没配齐，到点消息不会推送出去。' }],
          },
        }),
      },
      localPushSubscribed: true,
    });

    const credential = rowOf(rows, 'pushCredential');
    expect(credential.level).toBe('bad');
    expect(credential.detail).toContain('推送');
    expect(summarizeAmsgDiagnostics(rows)).toBe('bad');
  });

  it('浏览器订阅了但云端没登记 → 报红并指向「开启通知与推送」', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: { ...healthyReport().storage, pushSubscriptionRegistered: false },
        }),
      },
      localPushSubscribed: true,
    });

    const device = rowOf(rows, 'pushDevice');
    expect(device.level).toBe('bad');
    expect(device.detail).toContain('开启通知与推送');
  });

  it('这台设备根本没订阅时也报红，而不是看云端脸色', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: healthyReport() },
      localPushSubscribed: false,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('bad');
  });

  it('定时任务停摆时说出积压条数和该去哪儿看日志', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          tick: 'stalled',
          storage: {
            ...healthyReport().storage,
            pendingTasks: 3,
            overdueTasks: 3,
            oldestOverdueMinutes: 42,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const tick = rowOf(rows, 'tick');
    expect(tick.level).toBe('bad');
    expect(tick.detail).toContain('3');
    expect(tick.detail).toContain('42');
    expect(tick.detail).toContain('Observability');
  });

  it('手上没有待发任务时定时器一栏是 unknown，不冒充健康', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: healthyReport({ tick: 'unknown' }) },
      localPushSubscribed: true,
    });
    expect(rowOf(rows, 'tick').level).toBe('unknown');
  });

  it('旧 worker 没有体检端点时算 warn 不算坏（它只是查不了）', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: false, reason: '这台 Worker 上还没有体检端点。', unsupported: true },
    });
    expect(rowOf(rows, 'reachable').level).toBe('warn');
    expect(summarizeAmsgDiagnostics(rows)).toBe('warn');
  });
});
