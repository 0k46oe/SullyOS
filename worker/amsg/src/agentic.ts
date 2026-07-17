/**
 * amsg worker 满血 v2 — 服务端工具循环的纯逻辑（不碰网络 / 存储，方便单测）。
 *
 * 复用 instant push 的业务标签 classifier（../../instant-push/src/classifier）：
 *   - 数据标签（RECALL / SEARCH / READ_DIARY / XHS_* …）→ tool-request，
 *     由 index.ts 的 executeToolCalls 在 worker 里就地执行（客户端离线，
 *     没有 instant 那条「推回客户端跑」的路）。
 *   - 副作用标签（POKE / TRANSFER / MUSIC_ACTION / 写日记 …）→ 结构化成
 *     directives 挂在最后一条 push 的 metadata 上，客户端收到时重放
 *     （收侧与 instant 共用，activeMsgRuntime 的 isLastChunk 守卫已就位）。
 *
 * 与 instant 的关键差异：instant 每轮的旁白立刻推给用户；这里推送只在 finish
 * 时发生，所以中间轮的旁白和副作用要跨轮累积（FireSessionState），finish 时
 * 一起出——用户看到的内容与 instant 模式下逐轮看到的一致，只是一次到齐。
 */

import { classifyLLMOutput, type Directive, type ToolCall } from '../../instant-push/src/classifier';

/** 一次 fire 的跨轮累积状态（index.ts 按 sessionId 持有，finish/skip 后丢弃）。 */
export interface FireSessionState {
  /** 中间轮旁白（已剥数据 + 副作用标签的干净文本），finish 时排在正文前面。 */
  narrations: string[];
  /** 跨轮累积的副作用 directives。 */
  directives: Directive[];
}

export const createFireSessionState = (): FireSessionState => ({ narrations: [], directives: [] });

/** 组 push payload 需要的业务字段（都来自 sessionCtx / task metadata）。 */
export interface PushBuildInput {
  contactName: string;
  avatarUrl: string | null;
  /** 任务行 id（从 sess_task_<id> 拆出），拆不出为 null。 */
  taskId: string | null;
  /** 'auto' | 'prompted'（metadata.amsgMode 透传，缺省 'auto'）。 */
  messageType: string;
  metadata: Record<string, unknown>;
}

export type RoundDecision =
  | { decision: 'tool-request'; toolCalls: ToolCall[] }
  | { decision: 'finish'; pushPayloads: Array<Record<string, unknown>> }
  | { decision: 'skip-push' };

/** 和 amsg-server message-processor 的默认分句保持一致（SullyOS 不用 splitPattern）。 */
const DEFAULT_SPLIT_REGEX = /([。！？!?]+)/;
export const splitMessageIntoSentences = (content: string): string[] => {
  const out = content
    .split(DEFAULT_SPLIT_REGEX)
    .reduce<string[]>((acc, part, i, arr) => {
      if (i % 2 === 0 && part.trim()) {
        acc.push(part.trim() + (arr[i + 1] || ''));
      }
      return acc;
    }, [])
    .filter((s) => s.length > 0);
  return out.length > 0 ? out : [content];
};

/**
 * 处理一轮 LLM 输出（入参已 stripReasoningTags）：
 *   - 有数据标签 → 记下旁白与旁白里的副作用，返回 tool-request；
 *   - 无数据标签 → finish：累积旁白 + 本轮正文按句切 push，
 *     全部 directives 挂最后一条的 metadata；全程无正文且无副作用 → skip-push。
 */
export function processLLMRound(
  state: FireSessionState,
  llmOutputText: string,
  build: PushBuildInput,
): RoundDecision {
  const result = classifyLLMOutput(llmOutputText);

  if (result.kind === 'tool-request') {
    // prefix = 旁白 + 副作用标签（classifier 只剥数据标签）。对 prefix 再跑一次
    // 分类：此时没有数据标签，走 finish 分支，正好拿到「干净旁白 + 结构化副作用」。
    if (result.prefix) {
      const prefixScan = classifyLLMOutput(result.prefix);
      if (prefixScan.kind === 'finish') {
        if (prefixScan.cleanedText) state.narrations.push(prefixScan.cleanedText);
        state.directives.push(...prefixScan.directives);
      }
    }
    return { decision: 'tool-request', toolCalls: result.toolCalls };
  }

  const directives = [...state.directives, ...result.directives];
  const sentences = [...state.narrations, result.cleanedText]
    .filter((part) => part.trim().length > 0)
    .flatMap((part) => splitMessageIntoSentences(part));

  if (sentences.length === 0) {
    if (directives.length === 0) return { decision: 'skip-push' };
    // 整段只有副作用标签：发一条空正文 push 携带 directives。客户端
    // applyAssistantPostProcessing 对空正文产 0 气泡，副作用重放自己产
    // system message（与 instant 的 directive-only push 同款处理）。
    return {
      decision: 'finish',
      pushPayloads: [buildScheduledPush('', build, directives)],
    };
  }

  const lastIdx = sentences.length - 1;
  return {
    decision: 'finish',
    pushPayloads: sentences.map((sentence, i) =>
      buildScheduledPush(sentence, build, i === lastIdx ? directives : undefined),
    ),
  };
}

/**
 * 单句 → 老链路 scheduled push 形状（与 v1 完全一致，只多了可选的
 * metadata.directives）。messageId/sessionId/timestamp/messageIndex/totalMessages
 * 由库的 sendHookPushPayloads 统一补齐/覆写，这里只填业务字段。
 */
function buildScheduledPush(
  message: string,
  build: PushBuildInput,
  directives?: Directive[],
): Record<string, unknown> {
  return {
    messageKind: 'content' as const,
    messageType: build.messageType,
    source: 'scheduled' as const,
    message,
    title: `来自 ${build.contactName}`,
    contactName: build.contactName,
    avatarUrl: build.avatarUrl,
    messageSubtype: 'chat',
    taskId: build.taskId,
    metadata: directives && directives.length > 0
      ? { ...build.metadata, directives }
      : build.metadata,
  };
}
