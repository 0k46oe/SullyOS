// 即时对话（instant chat）客户端这一半的回归守卫。
//
// 钉的都是「坏了也不报错、只表现成体验变差」的那类行为：
//   1. POST 的形状——任务行型 / 任务身份 / fire_pack 带不带 chat 段。错一个字，
//      worker 到点要么拿主动消息模板去答聊天，要么整条硬失败，而用户只看到「一直在输入」。
//   2. 只有 202 才算发出去。别的状态一律「没发出去」，绝不静默退回本地生成。
//   3. 待收记录扛得住重启——它就是「正在输入…」那盏灯的唯一依据。
//   4. 补收对账：已经上过屏的那条不能再放一遍。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000009';

// _encrypt 换成「原样返回明文」，测里才读得到两个信封里到底装了什么。
const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn().mockResolvedValue(undefined),
    _encrypt: vi.fn(async (plaintext: string) => ({
      iv: 'iv', authTag: 'tag', encryptedData: plaintext,
    })),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const { storeState } = vi.hoisted(() => ({
  storeState: {
    config: {
      userId: '3f2b1c8a-9d4e-4a1b-8c2d-000000000009',
      workerUrl: 'https://amsg.example.workers.dev',
      serverToken: '',
      instantChatEnabled: true,
    } as Record<string, unknown>,
    inbox: [] as any[],
    saved: [] as any[],
  },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => storeState.config,
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
    listInboxMessages: async () => storeState.inbox,
    saveInboxMessage: async (message: any) => { storeState.saved.push(message); },
  },
}));

import { ActiveMsgClient } from './activeMsgClient';
import {
  AMSG_INSTANT_CHAT_PENDING_LS_KEY,
  chatOutboxPayloadToInbox,
  clearInstantChatPending,
  drainChatOutboxForChar,
  failInstantChatPending,
  getInstantChatPending,
  isInstantChatReady,
  sendInstantChatTurn,
  setInstantChatPending,
} from './amsgInstantChat';
import { FIRE_PACK_VERSION, unpackStateValue } from './amsgFirePack';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const CHAR = { id: 'char-instant-1', name: '小满', memories: [] } as any;
const USER = { name: '小明' } as any;
const API = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-test' };

const stubFirePackDeps = () => {
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
  vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
  vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
};

/** 装一个只认 /instant-chat 的假 fetch，返回它记下来的请求。 */
const mockInstantChatFetch = (status: number, body: unknown) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => 'application/json' },
    } as any;
  }));
  return calls;
};

beforeEach(() => {
  localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
  storeState.inbox = [];
  storeState.saved = [];
  storeState.config = {
    userId: TEST_USER_ID,
    workerUrl: 'https://amsg.example.workers.dev',
    serverToken: '',
    instantChatEnabled: true,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /instant-chat 的形状', () => {
  /** 跑一轮，返回解析好的请求体（两个信封已经是明文）。 */
  const postOnce = async (chatMessages: Array<{ role: string; content: unknown }>, supersedesUuid?: string) => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-1' });
    const result = await ActiveMsgClient.sendInstantChat({
      char: CHAR, chatMessages, api: API, maxTokens: 8000,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
      ...(supersedesUuid ? { supersedesUuid } : {}),
    });
    const body = JSON.parse(String(calls[0].init.body));
    return {
      result,
      call: calls[0],
      state: JSON.parse(body.statePayload.encryptedData),
      task: JSON.parse(body.taskPayload.encryptedData),
      supersedes: body.supersedesUuid,
    };
  };

  it('外壳是明文 JSON：两个信封已经加密好，别再给外壳挂加密头', async () => {
    const { call } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(call.url).toContain('/instant-chat');
    const headers = new Headers(call.init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-User-Id')).toBe(TEST_USER_ID);
    // 挂了的话包装层会把整个外壳当成一整份密文，statePayload / taskPayload 就解不出来。
    expect(headers.get('X-Payload-Encrypted')).toBeNull();
    expect(headers.get('X-Encryption-Version')).toBeNull();
  });

  it('任务行型是 auto + none，身份标着 instant', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    // 'instant' 在上游是「当场跑完」的行型，走不到 fire hooks，chat 段就白传了。
    expect(task.messageType).toBe('auto');
    expect(task.recurrenceType).toBe('none');
    // 标着 instant-chat 而不是 chat：面板对账靠这个标签把「用户正等着的这一轮」
    // 跟定时任务的行分开，不然它会被当成排程补进任务清单。
    expect(task.messageSubtype).toBe('instant-chat');
    expect(task.metadata.amsgMode).toBe('instant');
    expect(task.metadata.amsgInstantChat).toBe(true);
    expect(task.metadata.charId).toBe(CHAR.id);
    expect(typeof task.metadata.amsgClientTaskId).toBe('string');
    // 防穿帮闸问的是「到点还该不该主动开口」——带上它会把用户正等着的回复吞掉。
    expect(task.metadata.amsgExpirePolicy).toBeUndefined();
  });

  it('immediate: true 且不带 firstSendTime（落库即到期，慢机吃提前量的 400 无从发生）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.immediate).toBe(true);
    expect(task.firstSendTime).toBeUndefined();
  });

  it('顶替 uuid 只在加密信封里（上游同一事务原子取消），外壳明文不带', async () => {
    const { task, supersedes } = await postOnce([{ role: 'user', content: '在吗' }], 'uuid-prev');
    expect(task.supersedesUuid).toBe('uuid-prev');
    expect(supersedes).toBeUndefined();
  });

  it('没有可顶替的上一条时不带这个键', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.supersedesUuid).toBeUndefined();
  });

  // 情绪评估要跟这一轮一起上云（worker 跑完随最后一条推送把结果送回来）。它里头有
  // 用户副 API 的 apiKey，落点必须是加密的 taskPayload —— 掉进外壳明文或 statePayload
  // 都等于把凭据摊在网络上。
  it('情绪评估配置进的是加密的任务信封，明文外壳里一个字节都没有', async () => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-1' });
    const emotionEval = {
      prompt: '你是一个角色情绪分析系统。__EMOTION_EVAL_SYSTEM_PROMPT__\n__EMOTION_EVAL_HISTORY__',
      api: { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-secondary-KEYLEAK', model: 'eval-mini' },
    };
    await ActiveMsgClient.sendInstantChat({
      char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
      emotionEval,
    });

    const rawBody = String(calls[0].init.body);
    const body = JSON.parse(rawBody);
    const task = JSON.parse(body.taskPayload.encryptedData);
    expect(task.metadata.amsgEmotionEval).toEqual(emotionEval);
    // 外壳（除去两个信封本身）不许出现副 API 的 key
    const shell = { ...body, statePayload: undefined, taskPayload: undefined };
    expect(JSON.stringify(shell)).not.toContain('sk-secondary-KEYLEAK');
    // 云端状态那份也不该有：它跟任务信封是两码事，评估配置只跟着这一轮的任务走
    expect(body.statePayload.encryptedData).not.toContain('sk-secondary-KEYLEAK');
  });

  it('没配情绪评估就不带这个键（不是塞个空对象上去）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.metadata.amsgEmotionEval).toBeUndefined();
  });

  it('凭据带的是调用方给的那份（本地生成会用的同一份）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.apiUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(task.apiKey).toBe('sk-test');
    expect(task.primaryModel).toBe('gpt-test');
    expect(task.maxTokens).toBe(8000);
    expect(task.messages).toHaveLength(1);
  });

  it('云端状态是 v7 的 fire_pack，chat.messages 就是本地那串 fullMessages', async () => {
    const fullMessages = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: '今天怎么样' },
    ];
    const { state } = await postOnce(fullMessages);
    const firePackEntry = state.entries.find((e: any) => e.key === 'fire_pack');
    expect(firePackEntry).toBeTruthy();
    const pack = JSON.parse(await unpackStateValue(firePackEntry.value));
    expect(pack.v).toBe(FIRE_PACK_VERSION);
    expect(pack.chat.messages).toEqual(fullMessages);
    expect(typeof pack.chat.builtAt).toBe('number');
    // 排程那条路传的那几样一个都不能少（worker 到点全都要读）。
    const keys = state.entries.map((e: any) => e.key);
    expect(keys).toContain('tool_pack');
    expect(keys).toContain('tool_config');
  });

  // ── 轻量包：模板只有定时任务那条路才渲染 ──
  // 角色 2.0 关着（云端 fire 不注入排程工具）且没有任务时，每次发送重建一整份系统
  // 提示词 + 近史转写纯属白付——主线程二次构建 + 上行几十 KB 都发生在拿到 202 之前。
  it('角色 2.0 关着且无任务 → 模板用占位标记，系统提示词一次都不构建', async () => {
    const { state } = await postOnce([{ role: 'user', content: '在吗' }]);
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    const pack = JSON.parse(await unpackStateValue(entry.value));
    expect(pack.template).toContain('AMSG2_INSTANT_STUB_TEMPLATE');
    expect(pack.selfScheduleEnabled).toBe(false);
    // chat 段照常带全——即时 fire 吃的是它，不是模板
    expect(pack.chat.messages).toHaveLength(1);
    expect(ChatPrompts.buildSystemPrompt).not.toHaveBeenCalled();
  });

  it('角色 2.0 开着 → 照旧带真模板（云端 fire 可能当场排出会消费它的任务）', async () => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-real-template' });
    const charOn = { ...CHAR, activeMsg2Config: { enabled: true, tasks: [] } } as any;
    await ActiveMsgClient.sendInstantChat({
      char: charOn, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    const body = JSON.parse(String(calls[0].init.body));
    const state = JSON.parse(body.statePayload.encryptedData);
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    const pack = JSON.parse(await unpackStateValue(entry.value));
    expect(pack.template).toContain('SYS_PROMPT_MARKER');
    expect(pack.template).not.toContain('AMSG2_INSTANT_STUB_TEMPLATE');
    expect(pack.selfScheduleEnabled).toBe(true);
  });

  // ── 图片：云端这条路必须跟本地跑出来的一模一样 ──
  //
  // 拍平图片曾经是这里的做法，代价是模型看不到用户刚发的那张图，只能对着
  // 「[User sent an image]」硬答——而且答得挺像回事，用户根本看不出是这条路缺了东西。
  // 现在原样带上云，只在体积真的过不去时才从最老的开始丢，且当前这轮永不降级。

  /** 造一张「大图」：分段形状是真的，base64 内容用重复字符凑体积。 */
  const imageMessage = (role: string, kb: number, text = '[User sent an image]') => ({
    role,
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(kb * 1024)}` } },
    ],
  });

  const chatOf = async (state: any) => {
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    return JSON.parse(await unpackStateValue(entry.value)).chat;
  };

  it('带图片那条原样上云（结构化分段一个字都不动）', async () => {
    const structured = [
      { role: 'user', content: [
        { type: 'text', text: '[User sent an image]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ];
    const { state } = await postOnce(structured);
    const chat = await chatOf(state);
    // 回归守卫：拍平的话这里会变成字符串 '[User sent an image]'，图片就此消失
    expect(chat.messages).toEqual(structured);
    expect(JSON.stringify(chat.messages)).toContain('base64');
  });

  it('体积超标 → 从最老的消息开始丢图片本体，文字段留下', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 三张 1 MB 的图，预算 2 MiB：最老的那张必然要丢
    const { state } = await postOnce([
      imageMessage('user', 1024, '第一张'),
      imageMessage('assistant', 1024, '第二张'),
      { role: 'user', content: '最后这句没有图' },
    ]);
    const chat = await chatOf(state);
    expect(chat.messages[0].content).toBe('第一张');          // 丢成文字段
    expect(typeof chat.messages[0].content).toBe('string');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('最新那条用户消息的图片永远不丢（这一轮要聊的就是它）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state } = await postOnce([
      imageMessage('user', 1024, '很久以前那张'),
      imageMessage('assistant', 1024, '角色发的那张'),
      imageMessage('user', 512, '刚发出去的这张'),
    ]);
    const chat = await chatOf(state);
    const newest = chat.messages[2];
    // 回归守卫：从头往后丢的循环要是没跳过它，用户刚发的图就没了，而回复照样有
    expect(Array.isArray(newest.content)).toBe(true);
    expect(newest.content[1].image_url.url).toContain('base64');
    // 老的两条让位
    expect(typeof chat.messages[0].content).toBe('string');
    warn.mockRestore();
  });

  it('只剩最新那条还是超预算 → 抛错，不悄悄把当前这轮截断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(postOnce([imageMessage('user', 4096, '一张巨图')]))
      .rejects.toThrow(/图片太大/);
    warn.mockRestore();
  });

});

describe('只有 202 才算发出去', () => {
  const send = async (status: number, body: unknown) => {
    stubFirePackDeps();
    mockInstantChatFetch(status, body);
    return sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
  };

  it('202 → 记一笔待收记录', async () => {
    const result = await send(202, { status: 'accepted', uuid: 'uuid-ok' });
    expect(result.ok).toBe(true);
    expect(getInstantChatPending(CHAR.id)?.uuid).toBe('uuid-ok');
  });

  it('200 但没有 uuid → 算没发出去（别把「可能发了」当成发了）', async () => {
    const result = await send(200, { success: true });
    expect(result.ok).toBe(false);
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  it('401 → 明确告诉用户密钥对不上，不留待收记录', async () => {
    const result = await send(401, { success: false, error: { code: 'INVALID_CLIENT_TOKEN' } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('共享密钥');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  it('上游那一步挂了 → 原因带出来，仍然算没发出去', async () => {
    const result = await send(500, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_STATE_FAILED', message: '云端状态没传上去，这条没发出去',
        step: 'client-state', upstream: { error: { message: 'D1 timeout' } },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('INSTANT_CHAT_STATE_FAILED');
    expect(result.error).toContain('D1 timeout');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  // firstSendTime 是设备的钟加提前量算的，上游按自己的钟校验「必须在未来」——
  // 慢网大包上传或设备时钟偏慢都会把提前量吃光。这种失败要指条路（重试 / 查自动
  // 对时），不能掉进一句没人看得懂的 HTTP 400。
  it('上游打回「时间必须在未来」→ 文案指向网络慢 / 时钟偏慢', async () => {
    const result = await send(400, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_TASK_FAILED', message: '任务没建起来，这条没发出去',
        step: 'schedule-message',
        upstream: {
          success: false,
          error: {
            code: 'INVALID_TIMESTAMP', message: '时间必须在未来',
            details: { field: 'firstSendTime', reason: 'must be in the future' },
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('时钟');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });
});

describe('待收记录（「正在输入…」那盏灯的唯一依据）', () => {
  it('落在 localStorage 里，重启后还在', () => {
    setInstantChatPending('char-a', 'uuid-a', 1_000);
    // 模块状态每次都从存储读，等价于重开一次应用。
    expect(getInstantChatPending('char-a')).toEqual({ charId: 'char-a', uuid: 'uuid-a', acceptedAt: 1_000, charName: '' });
    expect(localStorage.getItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY)).toContain('uuid-a');
  });

  it('同角色只留最新一条（顶替之后旧 uuid 没人认领了）', () => {
    setInstantChatPending('char-a', 'uuid-1', 1_000);
    setInstantChatPending('char-a', 'uuid-2', 2_000);
    expect(getInstantChatPending('char-a')?.uuid).toBe('uuid-2');
  });

  it('销账是幂等的', () => {
    setInstantChatPending('char-a', 'uuid-a', 1_000);
    expect(clearInstantChatPending('char-a')).toBe(true);
    expect(clearInstantChatPending('char-a')).toBe(false);
    expect(getInstantChatPending('char-a')).toBeNull();
  });

  it('存储里躺着坏数据时当没有，不能把整条路带崩', () => {
    localStorage.setItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY, '{ 这不是 JSON');
    expect(getInstantChatPending('char-a')).toBeNull();
  });
});

// 这一轮以「没等到回复」收尾时，「情绪更新中」那盏灯也得跟着灭。
//
// 情绪评估的结果是搭最后一条回复的推送回来的（metadata.amsgEmotionDone）。可这一轮
// 要是**一条推送都没有**——模型空输出/纯拒答被 worker 判成 skip-push，或者整条 fire
// 硬失败——那个信号永远不会到，灯只能等 660 秒的安全网熄，期间还会弹一句「worker 可能
// 是旧版」的误导提示。云端已经点名说这一轮没成，就是最确定的熄灯时机。
describe('零推送收尾时也要熄灭情绪徽章', () => {
  // node 环境没有 window，给个最小 stub（这一组只关心派了哪些事件）。
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });

  /** 记下这一段派了哪些事件（spy 而不是手工换函数：restore 交给 vitest，漏还原不了）。 */
  const captureEvents = () => {
    const seen: Array<{ type: string; detail: any }> = [];
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: any) => {
      seen.push({ type: event?.type, detail: event?.detail });
      return true;
    });
    return { seen, restore: () => spy.mockRestore() };
  };

  it('销账成功 → 发一次 instant-emotion-done（徽章的熄灭信号）', async () => {
    setInstantChatPending('char-emo', 'uuid-emo', 1_000);
    const { seen, restore } = captureEvents();
    try {
      await failInstantChatPending('char-emo', 'uuid-emo', '云端生成失败');
    } finally {
      restore();
    }
    const done = seen.filter((e) => e.type === 'instant-emotion-done');
    expect(done).toHaveLength(1);
    expect(done[0].detail).toEqual({ charId: 'char-emo' });
  });

  // 结论迟到、用户已经又发了一条时，销的是新那一轮的账才叫出事——灯也一样：
  // 新那一轮的评估还在云端跑着，这时候熄灯等于骗人。
  it('结论对不上当前这一轮 → 一个事件都不发（新那一轮的灯不许碰）', async () => {
    setInstantChatPending('char-emo', 'uuid-new', 2_000);
    const { seen, restore } = captureEvents();
    try {
      await failInstantChatPending('char-emo', 'uuid-old', '迟到的结论');
    } finally {
      restore();
    }
    expect(seen.some((e) => e.type === 'instant-emotion-done')).toBe(false);
    expect(getInstantChatPending('char-emo')?.uuid).toBe('uuid-new');
  });
});

describe('开关', () => {
  it('设置页开了 + 地址填着 → 走云端', async () => {
    expect(await isInstantChatReady()).toBe(true);
  });

  it('开关没开 → 不走（每条消息都读这一份，别处不做第二道门）', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: false };
    expect(await isInstantChatReady()).toBe(false);
  });

  it('地址空着 → 不走', async () => {
    storeState.config = { ...storeState.config, workerUrl: '  ' };
    expect(await isInstantChatReady()).toBe(false);
  });
});

describe('推送丢了的补收对账', () => {
  const outboxPayload = (messageId: string) => ({
    messageKind: 'content',
    messageType: 'instant',
    source: 'scheduled',
    message: '我在呢',
    contactName: '小满',
    messageId,
    sessionId: 'sess-1',
    messageIndex: 1,
    totalMessages: 1,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    taskId: 7,
    taskUuid: 'uuid-round-1',
    occurrenceMs: 1_700_000_000_000,
    metadata: { charId: CHAR.id, charName: '小满', amsgInstantChat: true },
  });

  // 补收只对账目标轮（欠着回复的那一轮 / 显式点名的 uuid）：outbox 是跨轮环形数组，
  // 不过滤的话被重 roll / 手动删掉的旧轮回复会因「本地查无此 id」复活。
  beforeEach(() => setInstantChatPending(CHAR.id, 'uuid-round-1', 1_000));

  const stubOutbox = (messageIds: string[]) => {
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(JSON.stringify({
      v: 1,
      entries: messageIds.map((messageId) => ({
        messageId, sessionId: 'sess-1', at: 1_700_000_000_000, payload: outboxPayload(messageId),
      })),
    }));
  };

  it('没收到的那条写进收件箱，字段跟 SW 收真推送时写的一份对得上', async () => {
    stubOutbox(['msg_task_7@1700000000000_hook_0']);
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
    const written = await drainChatOutboxForChar(CHAR.id);
    expect(written).toBe(1);
    const saved = storeState.saved[0];
    expect(saved.charId).toBe(CHAR.id);
    expect(saved.body).toBe('我在呢');
    expect(saved.messageType).toBe('instant');
    expect(saved.taskId).toBe(7);
    expect(saved.metadata.sessionId).toBe('sess-1');
    expect(saved.sentAt).toBe(1_700_000_000_000);
  });

  it('已经上过屏的那条不再放一遍（对账读聊天记录里的 messageId）', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([messageId]);
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([
      { role: 'assistant', type: 'text', content: '我在呢', metadata: { activeMsg2: { messageId } } },
    ] as any);
    expect(await drainChatOutboxForChar(CHAR.id)).toBe(0);
    expect(storeState.saved).toHaveLength(0);
  });

  it('还压在收件箱里没冲刷的那条也算收过', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([messageId]);
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
    storeState.inbox = [{ messageId, charId: CHAR.id }];
    expect(await drainChatOutboxForChar(CHAR.id)).toBe(0);
  });

  it('不是目标轮的旧条目不复活（重 roll / 删除过的轮次已不在 pending 里）', async () => {
    clearInstantChatPending(CHAR.id);
    setInstantChatPending(CHAR.id, 'uuid-round-2', 2_000);   // 正在等的是新一轮
    stubOutbox(['msg_task_7@1700000000000_hook_0']);          // outbox 里只有旧轮（uuid-round-1）
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
    expect(await drainChatOutboxForChar(CHAR.id)).toBe(0);
    expect(storeState.saved).toHaveLength(0);
  });

  it('一条都不欠、也没显式点名 → 直接 0，一个请求都不发', async () => {
    clearInstantChatPending(CHAR.id);
    const read = vi.spyOn(ActiveMsgClient, 'readClientStateValue');
    expect(await drainChatOutboxForChar(CHAR.id)).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('显式点名 uuid（销账后的末段补扫）时不依赖 pending 存在', async () => {
    clearInstantChatPending(CHAR.id);
    stubOutbox(['msg_task_7@1700000000000_hook_0']);
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
    expect(await drainChatOutboxForChar(CHAR.id, { uuids: ['uuid-round-1'] })).toBe(1);
  });

  it('读不到近史时宁可这次不补收（重复上屏比晚一会儿更糟），对外报 null', async () => {
    stubOutbox(['msg_task_7@1700000000000_hook_0']);
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockRejectedValue(new Error('IDB down'));
    expect(await drainChatOutboxForChar(CHAR.id)).toBeNull();
    expect(storeState.saved).toHaveLength(0);
  });

  it('云端 outbox 读失败 → 返回 null（「没读到」≠「读到了、确实没有」），不抛错', async () => {
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockRejectedValue(new Error('offline'));
    expect(await drainChatOutboxForChar(CHAR.id)).toBeNull();
  });

  it('推送载荷少了 charId → 没有落点，丢掉而不是造一条无主消息', () => {
    expect(chatOutboxPayloadToInbox({ message: '孤儿' }, 1)).toBeNull();
  });

  // 契约测试：push→inbox 的字段映射有两份手工同步的副本（SW 的 saveContentToInbox 与
  // 这里的补收路径），销账检查只读 metadata.messageIndex/totalMessages、缺失当末段——
  // 任一副本漏抄这两个字段，多段回复的首段就会被当成末段销账，后续段永久丢失且无报错。
  // 这里钉住补收侧必须把顶层段号抄进 metadata（与 sw-keep-alive.ts 的映射同一条规则；
  // 那份是 SW 代码没法直接 import，改动 SW 映射时这条测试就是要一起过的清单）。
  it('顶层 messageIndex/totalMessages 必须抄进 metadata（销账检查只认 metadata 里的）', () => {
    const inbox = chatOutboxPayloadToInbox({
      charId: CHAR.id,
      charName: '小满',
      message: '第一段',
      messageId: 'msg_task_7@1700000000000_hook_0',
      sessionId: 'sess_task_7@1700000000000',
      taskUuid: 'uuid-round-1',
      messageIndex: 1,
      totalMessages: 3,
      metadata: { charId: CHAR.id },
    }, Date.now())!;
    expect(inbox).toBeTruthy();
    expect((inbox.metadata as any).messageIndex).toBe(1);
    expect((inbox.metadata as any).totalMessages).toBe(3);
    expect((inbox.metadata as any).sessionId).toBe('sess_task_7@1700000000000');
  });
});
