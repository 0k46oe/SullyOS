/**
 * amsg2ToolBridge — 把主动消息 2.0 的排程/取消/查询暴露为 OpenAI function-calling 工具，
 * 让角色在对话中直接创建定时消息（"提醒我 8 点问好"→ LLM 调 schedule_active_message）。
 *
 * 工具定义注入 useChatAI 的 tools 数组；执行器在工具循环里分发。
 */

import {
  ActiveMsg2CharacterConfig,
  APIConfig,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';

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
        '如果当前角色已有排程任务，新任务会自动替换旧任务。',
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
        },
        required: ['send_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_active_message',
      description: '取消当前角色的定时主动消息任务。如果没有排程中的任务，会返回提示。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_active_messages',
      description: '查看所有角色的定时主动消息任务列表（包括状态、下次发送时间等）。',
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
        return await handleCancel(deps);
      case 'list_active_messages':
        return await handleList();
      default:
        return `未知工具 ${toolName}。`;
    }
  } catch (e: any) {
    return `操作失败：${e?.message || String(e)}`;
  }
};

async function handleSchedule(args: Record<string, any>, deps: Amsg2ToolDeps): Promise<string> {
  const { char, userProfile, groups, realtimeConfig, apiConfig, updateCharacter } = deps;
  const mode = (args.mode === 'prompted' ? 'prompted' : 'auto') as 'auto' | 'prompted';
  const recurrence = (['daily', 'weekly'].includes(args.recurrence) ? args.recurrence : 'none') as 'none' | 'daily' | 'weekly';

  const config: ActiveMsg2CharacterConfig = {
    enabled: true,
    mode,
    firstSendTime: args.send_at,
    recurrenceType: recurrence,
    promptHint: mode === 'prompted' ? (args.prompt_hint || '') : undefined,
    taskUuid: char.activeMsg2Config?.taskUuid,
    useSecondaryApi: char.activeMsg2Config?.useSecondaryApi,
    secondaryApi: char.activeMsg2Config?.secondaryApi,
  };

  const result = await ActiveMsgClient.scheduleCharacterTask({
    char,
    config,
    userProfile,
    groups,
    realtimeConfig,
    apiConfig,
  });

  updateCharacter(char.id, {
    activeMsg2Config: {
      ...config,
      taskUuid: result.uuid,
      remoteStatus: result.status === 'sent' ? 'sent' : 'scheduled',
      lastSyncedAt: Date.now(),
      lastError: undefined,
    },
  });

  const timeDesc = new Date(args.send_at).toLocaleString('zh-CN', { hour12: false });
  const recurrenceDesc = recurrence === 'daily' ? '（每天重复）' : recurrence === 'weekly' ? '（每周重复）' : '';
  return `定时主动消息已创建。将在 ${timeDesc} 开始生成${recurrenceDesc}。模式：${mode === 'auto' ? '自动' : '提示词'}。`;
}

async function handleCancel(deps: Amsg2ToolDeps): Promise<string> {
  const { char, updateCharacter } = deps;
  const taskUuid = char.activeMsg2Config?.taskUuid;
  if (!taskUuid) {
    return '当前角色没有排程中的主动消息任务。';
  }

  await ActiveMsgClient.cancelTask(taskUuid);
  updateCharacter(char.id, {
    activeMsg2Config: {
      ...char.activeMsg2Config!,
      enabled: false,
      taskUuid: undefined,
      remoteStatus: 'idle',
      lastSyncedAt: Date.now(),
      lastError: undefined,
    },
  });

  return '已取消当前角色的定时主动消息任务。';
}

async function handleList(): Promise<string> {
  const tasks = await ActiveMsgClient.listTasks();
  if (!tasks || !tasks.length) {
    return '当前没有任何定时主动消息任务。';
  }
  const lines = tasks.map((t: any) => {
    const name = t.contactName || t.metadata?.charName || '未知角色';
    const status = t.status || 'unknown';
    const next = t.nextSendAt ? new Date(t.nextSendAt).toLocaleString('zh-CN', { hour12: false }) : '未知';
    const recurrence = t.recurrenceType === 'daily' ? '每天' : t.recurrenceType === 'weekly' ? '每周' : '一次性';
    return `- ${name}：${status}，下次 ${next}，${recurrence}`;
  });
  return `当前任务列表：\n${lines.join('\n')}`;
}

export const isAmsg2GlobalReady = async (): Promise<boolean> => {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    return !!config.workerUrl?.trim();
  } catch {
    return false;
  }
};
