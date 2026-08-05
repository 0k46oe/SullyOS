// 即时对话的接线守卫（源码级断言）。
//
// 仓库的 vitest 是纯 Node 环境（没装 jsdom），useChatAI 是个绑死 React 的大 hook、
// Chat.tsx 和设置面板是组件，都跑不起来测行为，所以沿用 amsg2ChatLoop.wiring.test.ts
// 的做法：读源码钉接线。它验证不了运行时时序，只防「接线被误删 / 改回去」这一种回归。
//
// 这里钉的每一条，塌了都不会报错，只会表现成「功能怎么不响」：
//   · 分流条件漏了工具循环的排除 → 瑞一杯/麦当劳选完城市没反应（请求交给 worker 了）；
//   · 失败时悄悄回本地跑 → 用户以为云端在跑，其实每条都在本地生成，查无可查；
//   · 收尾还打脏 → 同一份 fire_pack 再传一遍，白走一趟网络；
//   · 「正在输入…」不看落盘记录 → 关一次页面灯就没了，用户以为消息丢了；
//   · 路由不在构建 prompt 之前定下来 → 上云那份也烤前端时效段，一份 prompt 两个钟。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const chatAiSrc = read('../hooks/useChatAI.ts');
const chatSrc = read('../apps/Chat.tsx');
const settingsSrc = read('../components/settings/ActiveMsgGlobalSettingsModal.tsx');
const instantPushSettingsSrc = read('../components/settings/InstantPushSettingsModal.tsx');

/** 即时对话分支的判定行（分支起点、也是排序基准）。 */
const INSTANT_CHAT_BRANCH_HEAD = 'if (instantChatOn && !isInstantConfigReady())';

/** 路由判定那一段源码（在 buildChatRequestPayload 之前算好，上云与否 + 要不要剥时效段）。 */
const instantChatRouting = (() => {
  const start = chatAiSrc.indexOf('const luckinChatOn =');
  expect(start).toBeGreaterThan(-1);
  const end = chatAiSrc.indexOf('const payload = await stageT(', start);
  expect(end).toBeGreaterThan(start);
  return chatAiSrc.slice(start, end);
})();

/** 即时对话分支那一段源码（从判定行到它自己的 return）。 */
const instantChatBranch = (() => {
  const start = chatAiSrc.indexOf(INSTANT_CHAT_BRANCH_HEAD);
  expect(start).toBeGreaterThan(-1);
  const end = chatAiSrc.indexOf('// 流式预览：', start);
  expect(end).toBeGreaterThan(start);
  return chatAiSrc.slice(start, end);
})();

describe('useChatAI 的分流接缝', () => {
  it('MCP 不在排除名单里（worker 会跑后台 MCP；排掉它 = 配了 MCP 的人永远静默走本地）', () => {
    // e2e 实测踩过：只要全局有一台 enabled 的 MCP 服务器，mcpChatActive 对所有角色为真，
    // 排除它的话即时对话开关亮着却永远走本地生成，用户查无可查。
    // 判定挪到构建 payload 之前之后，这条要连路由那一段一起看。
    expect(instantChatRouting).not.toContain('mcpChatActive');
    expect(instantChatBranch).not.toContain('mcpChatActive');
  });

  it('上云的判定在构建 prompt 之前就定下来，并作为 timelyByWorker 交给 payload', () => {
    // 这一条钉的是「一份 prompt 只剩一个钟」：走云端时前端不烤时钟/节日/天气/热搜/
    // MCP 说明，那几段由 worker 在 fire 时刻独家补。判定要是又挪回分支里现算，
    // payload 就只能按全量构建，模型会同时读到前端快照和 worker 现拉的两份。
    expect(instantChatRouting).toContain('const instantChatRoute =');
    expect(chatAiSrc).toMatch(/timelyByWorker:\s*instantChatRoute/);
    const routeAt = chatAiSrc.indexOf('const instantChatRoute =');
    const payloadAt = chatAiSrc.indexOf('const payload = await stageT(');
    expect(routeAt).toBeGreaterThan(-1);
    expect(payloadAt).toBeGreaterThan(routeAt);
    // IP 还开着（脏配置）时那份 payload 必须是全量的——剥过时效段的 prompt 不能交给 IP。
    expect(instantChatRouting).toContain('!isInstantConfigReady()');
  });

  it('点单流程否决时留 trace，不许无声走本地', () => {
    // 瑞幸/麦当劳是客户端交互式循环，这一轮留在本地是对的；但否决必须可观测——
    // 静默分流那种「三个点照亮、哪条路都看不出」的坑不能再来一遍。
    // 否决现在和 payload.flags 同源、只是算得更早：三个来源就是那三个 flag 的原料。
    for (const source of ['luckinChatRef?.current?.active', 'mcdMiniOpen', 'luckinMiniOpen']) {
      expect(instantChatRouting).toContain(source);
    }
    expect(instantChatRouting).toContain('const instantChatVeto');
    expect(instantChatBranch).toContain("event: 'instant-chat-veto'");
    // 否决走的是「不 return、落回本地路径」，不能把整个分支 return 掉。
    const vetoAt = instantChatBranch.indexOf("event: 'instant-chat-veto'");
    const sendAt = instantChatBranch.indexOf('sendInstantChatTurn');
    expect(vetoAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(vetoAt);
  });

  it('两个分支都还在，且 Instant Push 排在即时对话前面（历史配置的兜底顺序不变）', () => {
    // 双向互斥后两边理论上不会同时亮着；这条钉的是万一出现脏配置（两个开关都读到
    // true）时谁先接手，顺序变了就是另一种未定义行为。
    const instantPushAt = chatAiSrc.indexOf('if (isInstantConfigReady() && !payload.flags.luckinChatActive');
    const instantChatAt = chatAiSrc.indexOf(INSTANT_CHAT_BRANCH_HEAD);
    expect(instantPushAt).toBeGreaterThan(-1);
    expect(instantChatAt).toBeGreaterThan(-1);
    expect(instantChatAt).toBeGreaterThan(instantPushAt);
  });

  it('云端拿到的就是本地要发的那串消息和那份凭据', () => {
    expect(instantChatBranch).toMatch(/chatMessages:\s*fullMessages/);
    expect(instantChatBranch).toMatch(/baseUrl:\s*effectiveApi\.baseUrl/);
    expect(instantChatBranch).toMatch(/model:\s*effectiveApi\.model/);
  });

  it('失败时不悄悄回本地生成：分支里没有本地 LLM 请求，走完就 return', () => {
    expect(instantChatBranch).not.toContain('safeFetchJson');
    expect(instantChatBranch).not.toContain('chat/completions');
    expect(instantChatBranch).toContain('return;');
  });

  it('失败时留下能看见的痕迹（系统消息 + 弹错），不是静默吞掉', () => {
    expect(instantChatBranch).toContain("role: 'system'");
    expect(instantChatBranch).toMatch(/showError\(/);
  });

  it('受理成功那一轮不再打脏重传 fire_pack', () => {
    expect(instantChatBranch).toContain('instantChatAccepted = true');
    expect(chatAiSrc).toMatch(/if \(!instantChatAccepted\) \{[\s\S]{0,200}markAmsgStateDirty\(/);
  });

  it('情绪评估照常在本地发一枪（云端那条链路没有这一步，不发就是悄悄停更）', () => {
    expect(instantChatBranch).toContain('fireLocalEmotionEval?.()');
  });

  it('不在这条路上开活跃会话租约（生成不在本机跑，没人需要它举手）', () => {
    // 租约那句排在分支的 return 之后，走这条路根本到不了。
    const leaseAt = chatAiSrc.indexOf('startAmsgChatPresence(char.id');
    expect(leaseAt).toBeGreaterThan(chatAiSrc.indexOf(INSTANT_CHAT_BRANCH_HEAD));
    expect(instantChatBranch).not.toContain('startAmsgChatPresence');
  });
});

describe('Chat 界面的「正在输入…」', () => {
  it('灯的依据是落盘的待收记录，而不是本轮的内存状态', () => {
    expect(chatSrc).toContain('getInstantChatPending');
    expect(chatSrc).toContain('AMSG_INSTANT_CHAT_PENDING_EVENT');
    // 只订阅事件、不读一次现状的话，重开应用时灯是灭的（记录还在，回复还没到）。
    expect(chatSrc).toMatch(/const sync = \(\) => setInstantChatPending\(/);
  });

  it('三个点的显示条件带上它（isTyping 在 POST 完就灭了）', () => {
    expect(chatSrc).toMatch(/\(isTyping \|\| instantChatPending \|\|/);
  });
});

describe('设置页那一道门', () => {
  it('版本门槛只有这一处：探 /config-check 的 instantChat 标志', () => {
    expect(settingsSrc).toContain('probeInstantChatSupport');
    // 逐调用预检会让每发一条消息多一次网络往返，而且探失败时分不清是旧版还是网抖。
    expect(chatAiSrc).not.toContain('probeInstantChatSupport');
  });

  it('四道门缺一不可，而且要说出卡在哪一道', () => {
    const reason = settingsSrc.slice(settingsSrc.indexOf('const instantChatBlockedReason'));
    expect(reason).toContain('!isConnected');
    expect(reason).toContain('pushStatus?.hasSubscription');
    expect(reason).toContain('instantChatSupported');
    expect(reason).toContain('instantOn');
  });

  it('开关落盘：两个 saveGlobalConfig 调用点都要带上它', () => {
    // 漏一处的话，用户改完 Worker 地址（或点一次「连接」）开关就被冲回默认值。
    const saves = settingsSrc.match(/ActiveMsgStore\.saveGlobalConfig\(\{[\s\S]{0,220}?\}\)/g) ?? [];
    expect(saves.length).toBeGreaterThanOrEqual(3);
    for (const save of saves) {
      expect(save).toContain('instantChatEnabled');
    }
  });
});

describe('设置页双向互斥门', () => {
  // 互斥是两个文件各持一半的跨文件约定：amsg2 面板挡「IP 开着时开即时对话」，
  // Instant Push 面板挡反过来那半。哪边被重构丢了，另一边都感觉不到——两个开关
  // 会一起亮着，聊天悄悄只走其中一条，用户完全看不出来。这里两条都要钉住。
  it('正向门：amsg2 面板读 isInstantConfigReady 判断 IP 是否开着', () => {
    expect(settingsSrc).toContain('isInstantConfigReady');
  });

  it('反向门：Instant Push 面板读 isInstantChatReady，且 handleSave 里有存档兜底', () => {
    expect(instantPushSettingsSrc).toContain('isInstantChatReady');
    // raceBlocked：存档前用最新读回的即时对话状态再夹一次 enabled，堵掉「modal 刚打开、
    // isInstantChatReady() 还没读回来」那一小段时间窗口里手快把 IP 勾上就保存的抢跑。
    const handleSave = instantPushSettingsSrc.slice(instantPushSettingsSrc.indexOf('const handleSave'));
    expect(handleSave).toContain('raceBlocked');
  });
});
