/**
 * amsg2 多任务清单的读取/派生工具集（浏览器侧；worker 不需要它）。
 *
 * 状态设计：清单只存 'scheduled'（取消即移除记录）。到点后的一次性任务不回写
 * 状态——「已发送 / 已作废」由消息历史现场推导（amsg2TaskContext），避免
 * React 之外（push 送达路径）写角色数据引发状态竞争。过点 48h 的一次性任务
 * 由 pruneStaleTasks 在下一次任务变更落盘时顺手清掉。
 */

import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  ActiveMsg2TaskRecord,
  CharacterProfile,
} from '../types';
import { FIRE_GRACE_MS, recurrencePeriodMs } from './amsg2ExpireGuard';

export const MAX_ACTIVE_TASKS_PER_CHAR = 5;

/**
 * 这个角色是否开着主动消息 2.0。
 *
 * 设置面板「关闭」会持久化 enabled:false，注入工具前必须过这道判定——否则被关掉的角色
 * 照样能调 schedule_active_message。从没配过的角色（config 缺失）算开启：默认可用，
 * 不需要先进面板点一下。
 *
 * 面板的开关初值和工具注入门都读这一个判定，别各写各的三元——两处答案不一致的话，
 * 面板显示「关」而角色其实照样能排程，界面就成了骗人的那一方。
 */
export const isAmsg2EnabledForChar = (char: CharacterProfile): boolean =>
  char.activeMsg2Config?.enabled !== false;

export const shortTaskId = (taskUuid: string): string => taskUuid.slice(0, 8);

/**
 * fixed 任务恒为 force：它没有 AI 生成环节，防穿帮闸的「作废」对它没有意义，
 * 而且 worker 的闸压根不会看到 fixed 任务。写任务记录的地方都过这里，别各写各的三元。
 */
export const resolveExpirePolicy = (
  mode: ActiveMsg2Mode,
  policy: ActiveMsg2ExpirePolicy | undefined,
): ActiveMsg2ExpirePolicy => (mode === 'fixed' ? 'force' : (policy ?? 'expire'));

// ─── 任务的人读文案 ───
// 角色的排程现状块、list_active_messages 的返回、设置面板的任务列表都显示同一批任务，
// 三处必须说同一套词——角色在上下文里看到的和它用工具查到的对不上，模型是会当成两回事的。

export const describeRecurrence = (recurrence: ActiveMsg2Recurrence): string =>
  recurrence === 'daily' ? '每天' : recurrence === 'weekly' ? '每周' : '一次性';

export const describeExpirePolicy = (policy: ActiveMsg2ExpirePolicy): string =>
  policy === 'force' ? '强制发送' : '遇忙作废';

/** 任务「要说什么」的一句话描述。fixed 有固定内容、prompted 有方向、auto 可带灵感。 */
export const describeTaskMode = (
  task: { mode: ActiveMsg2Mode; promptHint?: string },
): string => {
  if (task.mode === 'fixed') return '固定消息';
  if (task.mode === 'prompted') return `提示方向「${task.promptHint || ''}」`;
  return task.promptHint ? `自动（灵感：${task.promptHint}）` : '自动';
};

/**
 * 任务时间的统一显示格式（本地 24 小时制，精确到分）。
 * 不显示秒——cron 每整分才捞一次任务，秒位不代表任何东西，却要在窄卡片里占三个字符，
 * 把后面的重复方式和进度挤没。
 */
export const formatTaskTime = (value: number | string): string =>
  new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

/**
 * 把任意可解析的时间折成 datetime-local 输入框认的本地墙钟 'YYYY-MM-DDTHH:mm'。
 * 任务的 firstSendTime 有两种来源：面板建的本就是 datetime-local，角色用工具建的是
 * 完整 ISO 8601（带时区）——编辑角色任务时不折算会导致时间框空白。已是该格式的原样
 * 返回（幂等）；无法解析（空 / 坏值）也原样返回，不抛错。
 */
export const toDatetimeLocalValue = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
};

export const findTaskByShortId = (
  tasks: ActiveMsg2TaskRecord[],
  shortId: string,
): ActiveMsg2TaskRecord | undefined =>
  tasks.find((t) => shortTaskId(t.taskUuid) === shortId || t.taskUuid === shortId);

/** 待触发 = 还会响的任务：循环任务恒真；一次性任务触发点（含宽限）未过。 */
export const isPendingTask = (task: ActiveMsg2TaskRecord, nowMs: number): boolean => {
  if (task.status !== 'scheduled') return false;
  if (task.recurrenceType !== 'none') return true;
  const fireAt = new Date(task.firstSendTime).getTime();
  return Number.isFinite(fireAt) && fireAt + FIRE_GRACE_MS > nowMs;
};

/**
 * 当前该盯的那一次触发时刻。
 *
 * 一次性任务恒为 firstSendTime。循环任务的 firstSendTime 是「第一次」的时间，可能在
 * 好几天前，必须按周期推到当前这一次——否则清单会给一条每天的任务显示好几天前的时间
 * 配上「待触发」，看着就像过点了没响。停留条件用的是「加上送达宽限后仍在未来」，跟
 * isPendingTask 同一把尺，这样刚过点还在发的那一次不会被跳过。
 */
export const currentOccurrenceMs = (
  task: Pick<ActiveMsg2TaskRecord, 'firstSendTime' | 'recurrenceType'>,
  nowMs: number,
): number | null => {
  const first = new Date(task.firstSendTime).getTime();
  if (!Number.isFinite(first)) return null;

  const periodMs = recurrencePeriodMs(task.recurrenceType);
  if (periodMs === null) return first;

  // 找最小的 k（≥0）使 first + k*period + GRACE > now，直接算不要逐个迭代——
  // 循环任务可能已经跑了几个月。
  const k = Math.max(0, Math.floor((nowMs - FIRE_GRACE_MS - first) / periodMs) + 1);
  return first + k * periodMs;
};

/**
 * 任务当前进度的一句话（清单里跟在「重复方式」后面那个词）。
 *
 * 已过点的一次性任务光说「已到点」信息量为零——用户看不出它是发过了还是卡住了。
 * 远端底账正好能分辨：那一行还在 = worker 还没消费（cron 慢了或刚过点）；不在了 =
 * worker 已经处理完（发出去了，或者被防穿帮闸作废了，两种情况都会删行）。
 * 底账没拉到（null）时不猜，回到中性的「已到点」。
 */
export const describeTaskProgress = (
  task: ActiveMsg2TaskRecord,
  knownRemoteUuids: Set<string> | null,
  nowMs: number,
): string => {
  if (isPendingTask(task, nowMs)) return '待触发';
  if (knownRemoteUuids === null) return '已到点';
  return knownRemoteUuids.has(task.taskUuid) ? '已到点·待处理' : '已触发';
};

export const getPendingTasks = (
  config: ActiveMsg2CharacterConfig | undefined,
  nowMs: number,
): ActiveMsg2TaskRecord[] =>
  (config?.tasks ?? []).filter((t) => isPendingTask(t, nowMs));

/** 这个任务的触发有没有可能被防穿帮闸作废（fixed / force 永远照发）。 */
export const canExpire = (task: ActiveMsg2TaskRecord): boolean =>
  task.status === 'scheduled' && task.mode !== 'fixed' && task.expirePolicy === 'expire';

/** 有没有还会响的 AI 任务（amsgStateSync 的同步门用：fixed 不需要 fire_pack）。 */
export const hasActiveAiTask = (
  config: ActiveMsg2CharacterConfig | undefined,
  nowMs = Date.now(),
): boolean => getPendingTasks(config, nowMs).some((t) => t.mode !== 'fixed');

/** 替换任务时远端取消失败的标注文案（面板和工具侧共用一份，两边都会显示给人看）。 */
export const REPLACE_CANCEL_FAILED_NOTE = '替换时远端取消失败，任务可能仍会触发，可再次取消';

// ─── 远端对账：哪些任务在远端还活着 ───
// 面板打开时拉一次全量清单当底账，之后**不再重拉**，而是把每次远端操作的结果增量记进来。
// 底账是「打开那一刻」的快照，拿它去比对之后新建的任务，新任务必然不在里面——那样每次
// 新建都会立刻误标一行「远端不存在」，是纯粹的时序错觉。排程接口回了 success 就是这条
// 任务在远端存在的确证，直接记账即可，不用再多跑一次全量拉取。

/**
 * 把一次远端操作的结果并进底账。
 * `present` = 刚确认在远端存在的（新建/替换成功）；`gone` = 刚确认已不在的（取消成功）。
 *
 * 底账为 null（没拉到）时保持 null：新建一条任务并不能说明**其余**任务在不在远端，
 * 凭这半份证据开始对账会把别的任务全标成「远端不存在」。
 */
export const applyRemoteTaskDelta = (
  knownRemoteUuids: Set<string> | null,
  delta: { present?: string[]; gone?: string[] },
): Set<string> | null => {
  if (!knownRemoteUuids) return null;
  const next = new Set(knownRemoteUuids);
  delta.gone?.forEach((uuid) => next.delete(uuid));
  delta.present?.forEach((uuid) => next.add(uuid));
  return next;
};

/**
 * 这条任务该不该标「远端不存在」。
 * 只对**还会响**的任务判定：已过点的一次性任务本来就该从远端消失，标它是噪音。
 */
export const isRemoteMissingTask = (
  task: ActiveMsg2TaskRecord,
  knownRemoteUuids: Set<string> | null,
  nowMs: number,
): boolean =>
  knownRemoteUuids !== null
  && isPendingTask(task, nowMs)
  && !knownRemoteUuids.has(task.taskUuid);

/**
 * 已经走完的一次性任务出清单。
 *
 * 「走完」= 过了触发点、远端底账里也没有这一行。worker 领走任务后就会删掉那行，
 * 所以底账里找不到它 = 这一次已经处理完了，本地留着只会让清单越积越长（一天测下来
 * 就能攒出十来条一模一样的「已触发」）。判定跟 describeTaskProgress 是同一把尺：
 * 那里写「已触发」的，正是这里清掉的。
 *
 * 两种情况一律留着：
 *   - 带 lastError 的（比如替换时远端取消失败，远端可能还会照发）——那行错误是用户
 *     唯一能看见的线索，自动清掉等于把问题藏起来；
 *   - 底账没拉到（null）——分不出「远端处理完了」和「压根没读到远端」，一条都不动。
 *
 * 循环任务永远还会响，isPendingTask 对它们恒真，不会被这里带走。
 */
export const pruneFiredTasks = (
  tasks: ActiveMsg2TaskRecord[],
  knownRemoteUuids: Set<string> | null,
  nowMs: number,
): ActiveMsg2TaskRecord[] => {
  if (knownRemoteUuids === null) return tasks;
  return tasks.filter((task) => Boolean(task.lastError)
    || isPendingTask(task, nowMs)
    || knownRemoteUuids.has(task.taskUuid));
};

/**
 * 排程 / 替换成功后把新记录并进清单。
 *
 * 替换失败时**保留旧记录并标错**，绝不静默丢掉：远端此时新旧并存，本地要是只留新的，
 * 旧任务就成了没有短 id、谁都取消不了的幽灵任务。面板和角色工具两条路都走这里，
 * 规则只有一份。
 */
export const applyScheduledTask = (
  tasks: ActiveMsg2TaskRecord[],
  record: ActiveMsg2TaskRecord,
  opts: { replaceTaskUuid?: string; replacedCancelFailed?: boolean },
  nowMs: number,
): ActiveMsg2TaskRecord[] => {
  const rest = opts.replacedCancelFailed
    ? tasks.map((t) => t.taskUuid === opts.replaceTaskUuid
      ? { ...t, lastError: REPLACE_CANCEL_FAILED_NOTE }
      : t)
    : tasks.filter((t) => t.taskUuid !== opts.replaceTaskUuid);
  return pruneStaleTasks([...rest, record], nowMs);
};

/**
 * 关闭主动消息后，清单里该留下谁 —— 只留「远端还活着」的两类：
 *   1. 取消失败的（attempted 过但 failed）；
 *   2. 取消期间才出现的（不在 attempted 里，比如角色刚在聊天里排的）——压根没被取消过，
 *      跟着一起清掉就又是远端照发、面板看不见的幽灵任务。
 * 其余（成功取消的）出清单。
 */
export const keepUncancelledTasks = (
  tasks: ActiveMsg2TaskRecord[],
  attemptedUuids: Set<string>,
  failedUuids: Set<string>,
  notes: { failed: string; appeared: string },
): ActiveMsg2TaskRecord[] =>
  tasks
    .filter((t) => failedUuids.has(t.taskUuid) || !attemptedUuids.has(t.taskUuid))
    .map((t) => ({
      ...t,
      lastError: failedUuids.has(t.taskUuid) ? notes.failed : notes.appeared,
    }));

/** 过点超过 48h 的一次性任务出清单（排程现状块的回看期也是 48h，一致）。 */
export const pruneStaleTasks = (
  tasks: ActiveMsg2TaskRecord[],
  nowMs: number,
): ActiveMsg2TaskRecord[] =>
  tasks.filter((t) => {
    if (t.recurrenceType !== 'none') return true;
    const fireAt = new Date(t.firstSendTime).getTime();
    return !Number.isFinite(fireAt) || fireAt > nowMs - 48 * 3600_000;
  });
