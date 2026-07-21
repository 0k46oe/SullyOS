/**
 * amsg2ToolBridge — 把主动消息 2.0 的排程/取消/续期/查询暴露为 OpenAI function-calling 工具，
 * 让角色在对话中直接管理定时消息（"提醒我 8 点问好"→ LLM 调 schedule_active_message）。
 *
 * 工具定义注入 useChatAI 的 tools 数组；执行器在工具循环里分发。
 * 多任务：一个角色可同时挂多个任务，用短 id（taskUuid 前 8 位）定位。
 */

import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2TaskRecord,
  APIConfig,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import {
  findTaskByShortId, isPendingTask,
  normalizeActiveMsg2Config, pruneStaleTasks, shortTaskId,
} from './amsg2Tasks';

// ─── OpenAI tools schema ───

interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, any> };
}

export const AMSG2_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'schedule_active_message',
      description: [
        '创建定时主动消息：到指定时间后，你（角色）会根据最新聊天上下文自动生成并推送一条消息给用户。',
        '重要：send_at 是 worker 开始生成消息的请求时间，不是最终送达时间（中间有推理延迟，通常 10-30 秒）。',
        '如果要"卡点"送达（比如整点），建议提前 1 分钟。',
        '推荐使用 mode=auto：角色根据最新聊天内容自动决定说什么，后续聊天会自动同步至上下文。',
        'mode=prompted：给角色一个提示方向（如"问问对方吃了没"），角色围绕这个方向生成。',
        '每个角色最多同时挂 5 个任务；到点作废与否由 expire_policy 决定。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          send_at: {
            type: 'string',
            description: '开始生成消息的时间，ISO 8601 格式（如 2026-07-20T20:00:00+08:00）。必须晚于当前时间。',
          },
          mode: {
            type: 'string',
            enum: ['auto', 'prompted'],
            description: '生成模式。auto=根据最新聊天自动生成（推荐）；prompted=围绕 prompt_hint 方向生成。默认 auto。',
          },
          prompt_hint: {
            type: 'string',
            description: '仅 mode=prompted 时有效。给角色的提示方向，如"问问对方晚饭吃了没"。',
          },
          recurrence: {
            type: 'string',
            enum: ['none', 'daily', 'weekly'],
            description: '重复类型。none=一次性（默认）；daily=每天同一时间；weekly=每周同一天同一时间。',
          },
          expire_policy: {
            type: 'string',
            enum: ['expire', 'force'],
            description: '防穿帮策略。expire（默认）：到点时若对话在排程后已有新进展（或用户此刻正在聊天），任务自动作废——之后你会在排程现状里看到，由你决定自然带出、续期或放弃。force：无论用户是否正在聊天都照发，只用于用户明确要求的闹钟式定点提醒（如"8点必须叫我"）。',
          },
        },
        required: ['send_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_active_message',
      description: '取消当前角色的一个定时主动消息任务。多个任务并存时必须用 task_id（排程现状/任务列表里的短 id）指定；只有一个待触发任务时可省略。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '要取消的任务短 id（8 位）。' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'renew_active_message',
      description: '给一个任务续期：只换触发时间，沿用原有模式与提示方向（含已作废的任务）。若想说的内容或方向已经变了，不要用 renew，改用 cancel_active_message + schedule_active_message 重新创建。',
      parameters: {
        type: 'object',
        properties: {
          send_at: { type: 'string', description: '新的触发时间，ISO 8601 格式，必须晚于当前时间。' },
          task_id: { type: 'string', description: '要续期的任务短 id（8 位）。只有一个任务时可省略。' },
        },
        required: ['send_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_active_messages',
      description: '查看当前角色的定时主动消息任务列表（短 id、时间、模式、状态）。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const AMSG2_TOOL_NAMES = new Set(AMSG2_TOOLS.map((t) => t.function.name));

// ─── 执行器 ───

export interface Amsg2ToolDeps {
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  apiConfig: APIConfig;
  updateCharacter: (charId: string, updates: Partial<CharacterProfile>) => void;
}

export const executeAmsg2Tool = async (
  toolName: string,
  args: Record<string, any>,
  deps: Amsg2ToolDeps,
): Promise<string> => {
  try {
    switch (toolName) {
      case 'schedule_active_message':
        return await handleSchedule(args, deps);
      case 'cancel_active_message':
        return await handleCancel(args, deps);
      case 'renew_active_message':
        return await handleRenew(args, deps);
      case 'list_active_messages':
        return await handleList(deps);
      default:
        return `未知工具 ${toolName}。`;
    }
  } catch (e: any) {
    return `操作失败：${e?.message || String(e)}`;
  }
};

/** 读当前角色 config（含旧格式自愈）。 */
const readConfig = (char: CharacterProfile): ActiveMsg2CharacterConfig =>
  normalizeActiveMsg2Config(char.activeMsg2Config) ?? { enabled: true, tasks: [] };

/** 任务清单落盘：顺手清过点 48h 的一次性任务。 */
const persistTasks = (
  deps: Amsg2ToolDeps,
  config: ActiveMsg2CharacterConfig,
  tasks: ActiveMsg2TaskRecord[],
) => {
  deps.updateCharacter(deps.char.id, {
    activeMsg2Config: {
      ...config,
      enabled: true,
      tasks: pruneStaleTasks(tasks, Date.now()),
      lastSyncedAt: Date.now(),
      lastError: undefined,
    },
  });
};

async function handleSchedule(args: Record<string, any>, deps: Amsg2ToolDeps): Promise<string> {
  const { char, userProfile, groups, realtimeConfig, apiConfig } = deps;
  const config = readConfig(char);
  const mode = (args.mode === 'prompted' ? 'prompted' : 'auto') as 'auto' | 'prompted';
  const recurrence = (['daily', 'weekly'].includes(args.recurrence) ? args.recurrence : 'none') as 'none' | 'daily' | 'weekly';
  const expirePolicy = (args.expire_policy === 'force' ? 'force' : 'expire') as ActiveMsg2ExpirePolicy;
  const taskInput = {
    mode, firstSendTime: args.send_at, recurrenceType: recurrence,
    promptHint: mode === 'prompted' ? (args.prompt_hint || '') : (args.prompt_hint || undefined),
    expirePolicy,
  };

  const result = await ActiveMsgClient.scheduleCharacterTask({
    char, config, task: taskInput,
    replaceTaskUuid: args.__replaceTaskUuid,   // renew 内部复用，LLM 不感知
    userProfile, groups, realtimeConfig, apiConfig,
  });

  const record: ActiveMsg2TaskRecord = {
    taskUuid: result.uuid,
    clientTaskId: result.clientTaskId,
    ...taskInput,
    anchorLastUserMsgAt: result.anchorMs,
    source: 'character',
    status: 'scheduled',
    createdAt: Date.now(),
  };
  // 替换成功才移除旧记录；旧任务远端取消失败时保留旧记录并标错——短 id 还在，
  // 角色/用户可再次 cancel，不给远端留「本地看不见的幽灵任务」。
  const rest = result.replacedCancelFailed
    ? (config.tasks ?? []).map((t) => t.taskUuid === args.__replaceTaskUuid
        ? { ...t, lastError: '替换时远端取消失败，任务可能仍会触发，可再次 cancel' } : t)
    : (config.tasks ?? []).filter((t) => t.taskUuid !== args.__replaceTaskUuid);
  persistTasks(deps, config, [...rest, record]);

  const timeDesc = new Date(args.send_at).toLocaleString('zh-CN', { hour12: false });
  const recurrenceDesc = recurrence === 'daily' ? '（每天重复）' : recurrence === 'weekly' ? '（每周重复）' : '';
  return `定时主动消息已创建 [${shortTaskId(result.uuid)}]。将在 ${timeDesc} 开始生成${recurrenceDesc}。模式：${mode === 'auto' ? '自动' : '提示词'}，策略：${expirePolicy === 'force' ? '强制发送' : '遇忙作废'}。`;
}

/** 按 task_id 参数（或"只有一个就选它"）解出目标任务；解不出返回给 LLM 的提示文案。 */
const resolveTargetTask = (
  config: ActiveMsg2CharacterConfig,
  taskIdArg: unknown,
): { task?: ActiveMsg2TaskRecord; error?: string } => {
  const tasks = config.tasks ?? [];
  if (typeof taskIdArg === 'string' && taskIdArg.trim()) {
    const task = findTaskByShortId(tasks, taskIdArg.trim());
    return task ? { task } : { error: `没有找到短 id 为 ${taskIdArg} 的任务，请先用 list_active_messages 查看。` };
  }
  const pending = tasks.filter((t) => isPendingTask(t, Date.now()));
  if (pending.length === 1) return { task: pending[0] };
  if (pending.length === 0 && tasks.length === 1) return { task: tasks[0] };
  return { error: '当前有多个任务，请带 task_id（短 id）指定要操作哪一个。' };
};

async function handleCancel(args: Record<string, any>, deps: Amsg2ToolDeps): Promise<string> {
  const config = readConfig(deps.char);
  if (!(config.tasks ?? []).length) return '当前角色没有排程中的主动消息任务。';
  const { task, error } = resolveTargetTask(config, args.task_id);
  if (!task) return error!;

  try {
    await ActiveMsgClient.cancelTask(task.taskUuid);
  } catch (e) {
    // 远端取消失败绝不静默移除本地记录（Codex #4）——否则远端 recurring 照发、
    // 本地却没了短 id，用户再也无法通过工具取消。
    console.warn('[amsg2ToolBridge] cancel remote task failed（保留本地记录待重试）', e);
    persistTasks(deps, config, (config.tasks ?? []).map((t) =>
      t.taskUuid === task.taskUuid ? { ...t, lastError: '远端取消失败，任务可能仍会触发' } : t));
    return `取消任务 [${shortTaskId(task.taskUuid)}] 失败（远端未确认），稍后可重试。`;
  }
  persistTasks(deps, config, (config.tasks ?? []).filter((t) => t.taskUuid !== task.taskUuid));
  return `已取消任务 [${shortTaskId(task.taskUuid)}]。`;
}

async function handleRenew(args: Record<string, any>, deps: Amsg2ToolDeps): Promise<string> {
  const config = readConfig(deps.char);
  if (!(config.tasks ?? []).length) return '当前角色没有可续期的任务，请用 schedule_active_message 新建。';
  const { task, error } = resolveTargetTask(config, args.task_id);
  if (!task) return error!;
  if (task.mode === 'fixed') return '固定消息任务请在设置面板调整。';
  // renew 只换时间：复用 schedule 的替换语义（旧任务已被 worker 删掉时 cancel
  // 失败只 warn）。内容/方向要变就不该走这里——工具描述已引导 cancel + 重建。
  return handleSchedule({
    send_at: args.send_at,
    mode: task.mode,
    prompt_hint: task.promptHint,
    recurrence: task.recurrenceType,
    expire_policy: task.expirePolicy ?? 'expire',
    __replaceTaskUuid: task.taskUuid,
  }, deps);
}

async function handleList(deps: Amsg2ToolDeps): Promise<string> {
  const config = readConfig(deps.char);
  const tasks = config.tasks ?? [];
  if (!tasks.length) return '当前角色没有任何定时主动消息任务。';
  const now = Date.now();
  const lines = tasks.map((t) => {
    const time = new Date(t.firstSendTime).toLocaleString('zh-CN', { hour12: false });
    const recurrence = t.recurrenceType === 'daily' ? '每天' : t.recurrenceType === 'weekly' ? '每周' : '一次性';
    const what = t.mode === 'fixed' ? '固定消息' : t.mode === 'prompted' ? `提示方向「${t.promptHint || ''}」` : '自动';
    const state = isPendingTask(t, now) ? '待触发' : '已到点';
    const policy = (t.expirePolicy ?? 'expire') === 'force' ? '强制发送' : '遇忙作废';
    return `- [${shortTaskId(t.taskUuid)}] ${time} ${recurrence} · ${what} · ${policy} · ${state}${t.lastError ? ` · ⚠ ${t.lastError}` : ''}`;
  });
  return `当前角色的任务列表：\n${lines.join('\n')}`;
}

export const isAmsg2GlobalReady = async (): Promise<boolean> => {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    return !!config.workerUrl?.trim();
  } catch {
    return false;
  }
};
