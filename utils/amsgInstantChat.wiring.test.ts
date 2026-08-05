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
//
// 取源码片段统一走 sliceSrc（下面那个 helper）：按需调用、两个锚点都要命中，
// 找不到就抛一条写明是哪一段、缺哪个锚点的错，只挂真正用到它的那几条用例。
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
const INSTANT_CHAT_BRANCH_HEAD = 'if (instantChatRoute)';
/** Instant Push 分支的判定行（脏配置时它先接手）。 */
const INSTANT_PUSH_BRANCH_HEAD = 'if (instantPushConfigured && !payload.flags.luckinChatActive';
/** 路由判定那一段的起点（一回合只读一次 Instant Push 配置，就是从这行开始）。 */
const ROUTING_HEAD = 'const instantPushConfigured =';

/**
 * 取一段源码：从起点锚点到终点锚点之间。两个锚点都要求命中，找不到就抛一条写明
 * 「哪一段、哪个锚点」的错——按需调用，只有真正用到这一段的用例会挂，其余照跑。
 * （别在模块顶层取：那样锚点一改名整份文件在收集阶段就集体阵亡，报出来的还是
 * `expected -1 to be greater than -1`，看不出是哪条不变量塌了。）
 */
const sliceSrc = (src: string, label: string, startAnchor: string, endAnchor: string): string => {
  const start = src.indexOf(startAnchor);
  if (start < 0) {
    throw new Error(`[${label}] 找不到起点锚点 ${JSON.stringify(startAnchor)}。先确认这条不变量本身还在（只是改了名就更新锚点，被删了就是真回归）。`);
  }
  const end = src.indexOf(endAnchor, start);
  if (end <= start) {
    throw new Error(`[${label}] 起点之后找不到终点锚点 ${JSON.stringify(endAnchor)}，这一段的边界变了。`);
  }
  return src.slice(start, end);
};

/** 路由判定那一段源码（在 buildChatRequestPayload 之前算好，上云与否 + 要不要剥时效段 + 没上云的留痕）。 */
const routingSrc = () => sliceSrc(chatAiSrc, '即时对话路由段', ROUTING_HEAD, 'const payload = await stageT(');

/** 即时对话分支那一段源码（从判定行到它自己的 return）。 */
const branchSrc = () => sliceSrc(chatAiSrc, '即时对话分支', INSTANT_CHAT_BRANCH_HEAD, '// 流式预览：');

describe('useChatAI 的分流接缝', () => {
  it('MCP 不在排除名单里（worker 会跑后台 MCP；排掉它 = 配了 MCP 的人永远静默走本地）', () => {
    // e2e 实测踩过：只要全局有一台 enabled 的 MCP 服务器，mcpChatActive 对所有角色为真，
    // 排除它的话即时对话开关亮着却永远走本地生成，用户查无可查。
    // 判定挪到构建 payload 之前之后，这条要连路由那一段一起看。
    expect(routingSrc()).not.toContain('mcpChatActive');
    expect(branchSrc()).not.toContain('mcpChatActive');
  });

  it('上云的判定在构建 prompt 之前就定下来，并作为 timelyByWorker 交给 payload', () => {
    // 这一条钉的是「一份 prompt 只剩一个钟」：走云端时前端不烤时钟/节日/天气/热搜/
    // MCP 说明，那几段由 worker 在 fire 时刻独家补。判定要是又挪回分支里现算，
    // payload 就只能按全量构建，模型会同时读到前端快照和 worker 现拉的两份。
    expect(routingSrc()).toContain('const instantChatRoute =');
    expect(chatAiSrc).toMatch(/timelyByWorker:\s*instantChatRoute/);
    const routeAt = chatAiSrc.indexOf('const instantChatRoute =');
    const payloadAt = chatAiSrc.indexOf('const payload = await stageT(');
    expect(routeAt).toBeGreaterThan(-1);
    expect(payloadAt).toBeGreaterThan(routeAt);
    // IP 还开着（脏配置）时那份 payload 必须是全量的——剥过时效段的 prompt 不能交给 IP。
    expect(routingSrc()).toContain('!instantPushConfigured');
  });

  it('Instant Push 配没配着，一回合只读一次（读两次能读出两个答案）', () => {
    // 从路由判定到真正分流之间隔着好几个 await，用户在设置页存一次盘就能把它翻面。
    // 各读各的话：按上云剥掉时效段的 prompt，最后却交给 IP 或落回本地生成。
    const reads = chatAiSrc.match(/isInstantConfigReady\(\)/g) ?? [];
    expect(reads.length).toBe(1);
    expect(routingSrc()).toContain(`${ROUTING_HEAD} isInstantConfigReady()`);
    // 三个消费方都吃这一个 const（情绪评估的 instantOn 也在内，它决定评估在本地跑还是打包上云）。
    expect(chatAiSrc).toContain(INSTANT_PUSH_BRANCH_HEAD);
    expect(chatAiSrc).toContain(INSTANT_CHAT_BRANCH_HEAD);
    expect(chatAiSrc).toMatch(/const instantOn = instantPushConfigured;/);
  });

  it('分支只认 instantChatRoute，不拿原料重算一遍', () => {
    // 「这份 prompt 剥没剥时效段」和「这一轮走不走云端」必须出自同一个值。分支要是
    // 自己再拿 instantChatOn / instantPushConfigured / 否决名单拼一次条件，两处早晚
    // 会不同意——剥过时效段的 prompt 就落到 IP 或本地那条路上去了。
    const branch = branchSrc();
    for (const reDerived of ['instantChatOn', 'instantPushConfigured', 'instantChatVeto', 'isInstantConfigReady']) {
      expect(branch).not.toContain(reDerived);
    }
    // 上云那一路一进来就直奔发送，中间没有别的门。
    expect(branch.indexOf('sendInstantChatTurn')).toBeGreaterThan(-1);
    expect(branch).toContain('return;');
  });

  it('开着即时对话却没上云 —— 每一种情形都在路由段留 trace，就这一处', () => {
    // 两种原因：点单流程否决（瑞幸/麦当劳要客户端交互，这一轮留在本地是对的）、
    // IP 配置也还在（脏配置，交给 IP，它不接就落回本地）。两个同时成立时报点单那个。
    // 哪一种没留痕，都是「开关亮着、消息照常出来」的静默分流，用户查无可查。
    const routing = routingSrc();
    // 否决的三个来源和 payload.flags 同源，只是算得更早
    for (const source of ['luckinChatRef?.current?.active', 'mcdMiniOpen', 'luckinMiniOpen']) {
      expect(routing).toContain(source);
    }
    expect(routing).toContain('const instantChatVeto');
    expect(routing).toContain("event: 'instant-chat-veto'");
    expect(routing).toMatch(/instantChatVeto \?\? 'instant-push-configured'/);
    // 判定用的是「上云没成」这个总口径，不是逐个原因去数——漏一种就又静默了。
    expect(routing).toMatch(/if \(instantChatOn && !instantChatRoute\)/);
    // 留痕只此一处：多写一处迟早会漏掉某种情形，或者同一轮报两遍。
    const traceSites = chatAiSrc.match(/event: 'instant-chat-veto'/g) ?? [];
    expect(traceSites.length).toBe(1);
    // 只报不拦：报完照常往下走本地路径，不能顺手 return 掉整轮。
    expect(routing).not.toContain('return;');
  });

  it('两个分支都还在，且 Instant Push 排在即时对话前面（历史配置的兜底顺序不变）', () => {
    // 双向互斥后两边理论上不会同时亮着；这条钉的是万一出现脏配置（两个开关都读到
    // true）时谁先接手，顺序变了就是另一种未定义行为。
    const instantPushAt = chatAiSrc.indexOf(INSTANT_PUSH_BRANCH_HEAD);
    const instantChatAt = chatAiSrc.indexOf(INSTANT_CHAT_BRANCH_HEAD);
    expect(instantPushAt).toBeGreaterThan(-1);
    expect(instantChatAt).toBeGreaterThan(-1);
    expect(instantChatAt).toBeGreaterThan(instantPushAt);
  });

  it('云端拿到的就是本地要发的那串消息和那份凭据', () => {
    expect(branchSrc()).toMatch(/chatMessages:\s*fullMessages/);
    expect(branchSrc()).toMatch(/baseUrl:\s*effectiveApi\.baseUrl/);
    expect(branchSrc()).toMatch(/model:\s*effectiveApi\.model/);
  });

  it('失败时不悄悄回本地生成：分支里没有本地 LLM 请求，走完就 return', () => {
    expect(branchSrc()).not.toContain('safeFetchJson');
    expect(branchSrc()).not.toContain('chat/completions');
    expect(branchSrc()).toContain('return;');
  });

  it('失败时留下能看见的痕迹（系统消息 + 弹错），不是静默吞掉', () => {
    expect(branchSrc()).toContain("role: 'system'");
    expect(branchSrc()).toMatch(/showError\(/);
  });

  it('受理成功那一轮不再打脏重传 fire_pack', () => {
    expect(branchSrc()).toContain('instantChatAccepted = true');
    expect(chatAiSrc).toMatch(/if \(!instantChatAccepted\) \{[\s\S]{0,200}markAmsgStateDirty\(/);
  });

  // 情绪评估跟着这一轮一起上云：用户发完就能关页面，评估在 worker 里跑完，结果随
  // 最后一条推送回来。留在本地发一枪的话，页面一关情绪底色和意识流就悄悄停更了。
  it('情绪评估跟着一起交给云端，不在本地再发一枪', () => {
    expect(branchSrc()).toContain('emotionEval: cloudEmotionEval');
    expect(branchSrc()).not.toContain('fireLocalEmotionEval');
    // 本地那一枪的开关也得认这条路：cloudGenRoute 把即时对话算进去，
    // 不然两边会同时跑评估（双扣费，而且后落的那份会盖掉先落的）。
    expect(chatAiSrc).toMatch(/const cloudGenRoute = instantOn \|\| instantChatRoute;/);
    expect(chatAiSrc).toMatch(/const fireLocalEmotionEval = \(emotionEvalEnabled && !cloudGenRoute/);
  });

  it('不在这条路上开活跃会话租约（生成不在本机跑，没人需要它举手）', () => {
    // 租约那句排在分支的 return 之后，走这条路根本到不了。
    const leaseAt = chatAiSrc.indexOf('startAmsgChatPresence(char.id');
    expect(leaseAt).toBeGreaterThan(chatAiSrc.indexOf(INSTANT_CHAT_BRANCH_HEAD));
    expect(branchSrc()).not.toContain('startAmsgChatPresence');
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
    const reason = sliceSrc(settingsSrc, '即时对话开关的置灰理由', 'const instantChatBlockedReason', '\n  return (');
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
    const handleSave = sliceSrc(instantPushSettingsSrc, 'Instant Push 面板的 handleSave', 'const handleSave', '\n  };');
    expect(handleSave).toContain('raceBlocked');
  });
});
