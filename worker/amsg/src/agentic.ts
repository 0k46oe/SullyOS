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
import { sanitizeIntoSegments } from '../../../utils/sanitize';
// type-only：编译期擦除，不会把 realtimeContext 的浏览器依赖打进 worker bundle。
import type { XhsNote } from '../../../utils/realtimeContext';

/** 一次 fire 的跨轮累积状态（index.ts 按 sessionId 持有，finish/skip 后丢弃）。 */
export interface FireSessionState {
  /**
   * 中间轮旁白的**原始文本**（只剥了数据标签，副作用标签原样保留）。
   * 副作用不逐轮结构化——长形态日记这类跨行标签块可能被数据标签劈开两轮
   * （写日记写一半去 [[RECALL]]），逐轮扫会把孤立的 DIARY_START / DIARY_END
   * 当正文漏进 push、日记也丢。finish 时拼回全文统一扫一次。
   */
  narrations: string[];
}

export const createFireSessionState = (): FireSessionState => ({ narrations: [] });

/** 组 push payload 需要的业务字段（都来自 sessionCtx / task metadata）。 */
export interface PushBuildInput {
  contactName: string;
  avatarUrl: string | null;
  /** 任务行 id（从 sess_task_<id> 拆出），拆不出为 null。 */
  taskId: string | null;
  /** 'auto' | 'prompted'（metadata.amsgMode 透传，缺省 'auto'）。 */
  messageType: string;
  metadata: Record<string, unknown>;
  /** 本次触发时刻（任务行 next_send_at），随每条 push 的 metadata.amsgOccurrenceMs 带回客户端。 */
  occurrenceMs?: number | null;
  /**
   * round 1 XHS 工具抓到的笔记快照（stash.toolCtx.lastXhsNotesRef.current）。
   * amsg2 的 round 1 在 worker 里跑，客户端没有 instantToolRunner 那次
   * saveXhsSessionNotes 落库——不带回去 [[XHS_SHARE: n]] 重放必然 available:0。
   * finish 时只挑 directive 引用到的几张随最后一条 push 带回（web push 单条
   * payload ~4KB，全量 8 张会撑爆整条 push，那就不是掉卡片而是掉消息了）。
   */
  xhsNotes?: XhsNote[];
  /** xsecToken 缓存快照（[noteId, token][]），点赞/评论/回复重放时客户端要用。 */
  xhsXsecTokens?: Array<[string, string]>;
}

/** 挂在最后一条 push metadata.xhsSession 的形状；idx 1-based，与 [[XHS_SHARE: n]] 同基。 */
export interface XhsSessionPayload {
  notes: Array<{ idx: number; note: XhsNote }>;
  xsecTokens: Array<[string, string]>;
}

/** desc 截断长度：卡片预览够用，省 push 配额。 */
const XHS_DESC_MAX = 120;
/** 最多带几张笔记：share 正常 1-3 张，超出说明 LLM 在刷屏，保 push 送达优先。 */
const XHS_NOTES_MAX = 4;

/**
 * 从 finish 时的全部 directives 里挑出 XHS 引用，组客户端重放要的最小数据包：
 *   - xhs_share 的 idx → 对应笔记（越界/编造的序号取不到就跳过，客户端照旧警告）；
 *   - xhs_like / fav / comment / reply 的 noteId → 对应 xsecToken。
 * 没有任何 XHS 引用（或引用全落空）→ null，metadata 不多挂键。
 */
export function buildXhsSessionPayload(
  directives: Directive[],
  notes: XhsNote[] | undefined,
  xsecTokens: Array<[string, string]> | undefined,
): XhsSessionPayload | null {
  if (directives.length === 0) return null;
  const sharedIdx = new Set<number>();
  const refNoteIds = new Set<string>();
  for (const d of directives) {
    if (d.type === 'xhs_share') sharedIdx.add(d.idx);
    else if (d.type === 'xhs_like' || d.type === 'xhs_fav') refNoteIds.add(d.noteId);
    else if (d.type === 'xhs_comment' || d.type === 'xhs_reply') refNoteIds.add(d.noteId);
  }
  if (sharedIdx.size === 0 && refNoteIds.size === 0) return null;

  const pickedNotes: XhsSessionPayload['notes'] = [];
  for (const idx of [...sharedIdx].sort((a, b) => a - b)) {
    const note = idx >= 1 ? notes?.[idx - 1] : undefined;
    if (!note) continue;
    pickedNotes.push({ idx, note: { ...note, desc: (note.desc || '').slice(0, XHS_DESC_MAX) } });
    if (pickedNotes.length >= XHS_NOTES_MAX) break;
  }
  const pickedTokens = (xsecTokens ?? []).filter(([noteId]) => refNoteIds.has(noteId));

  if (pickedNotes.length === 0 && pickedTokens.length === 0) return null;
  return { notes: pickedNotes, xsecTokens: pickedTokens };
}

export type RoundDecision =
  | { decision: 'tool-request'; toolCalls: ToolCall[] }
  | { decision: 'finish'; pushPayloads: Array<Record<string, unknown>> }
  | { decision: 'skip-push' };

/**
 * 处理一轮 LLM 输出（入参已 stripReasoningTags）：
 *   - 有数据标签 → 原始旁白（prefix）暂存，返回 tool-request；
 *   - 无数据标签 → finish：把全部中间轮旁白 + 本轮正文**拼回一份全文**统一
 *     classify（跨轮被劈开的副作用标签块在这里合体），干净正文经
 *     sanitizeIntoSegments 分段（与 instant push / 客户端 chatParser.chunkText
 *     同一份：按换行切、[[...]] / [html] / <翻译> / <语音> 等标签块保持原子），
 *     每段一条 push；全部 directives 挂最后一条的 metadata；
 *     全程无正文且无副作用 → skip-push。
 */
export function processLLMRound(
  state: FireSessionState,
  llmOutputText: string,
  build: PushBuildInput,
): RoundDecision {
  const result = classifyLLMOutput(llmOutputText);

  if (result.kind === 'tool-request') {
    // prefix = 旁白 + 可能只写了一半的副作用标签块。这里不剥不结构化——
    // 等 finish 拼回全文统一扫（见 FireSessionState.narrations 注释）。
    if (result.prefix.trim()) state.narrations.push(result.prefix);
    return { decision: 'tool-request', toolCalls: result.toolCalls };
  }

  // 拼回全文再扫一次。中间轮 prefix 里不含数据标签（prefix 定义即「首个数据标签
  // 之前」），本轮正文也没有（有就走上面 tool-request 分支了），所以这次分类必然
  // 落 finish；万一未来 classifier 语义变化落了 tool-request，取其 prefix 兜底，
  // 不让 fire 链在 finish 关头断掉。
  const fullText = [...state.narrations, llmOutputText]
    .filter((part) => part.trim().length > 0)
    .join('\n');
  const finalScan = classifyLLMOutput(fullText);
  const cleanedText = finalScan.kind === 'finish' ? finalScan.cleanedText : finalScan.prefix;
  const directives = finalScan.kind === 'finish' ? finalScan.directives : [];

  // XHS 引用的笔记/token 与 directives 挂同一条 push（最后一条），客户端先落库再重放。
  const xhsSession = buildXhsSessionPayload(directives, build.xhsNotes, build.xhsXsecTokens);
  const finishMeta = directives.length > 0
    ? { directives, ...(xhsSession ? { xhsSession } : {}) }
    : undefined;
  const segments = sanitizeIntoSegments(cleanedText);

  if (segments.length === 0) {
    if (!finishMeta) return { decision: 'skip-push' };
    // 整段只有副作用标签：发一条空正文 push 携带 directives。客户端
    // applyAssistantPostProcessing 对空正文产 0 气泡，副作用重放自己产
    // system message（与 instant 的 directive-only push 同款处理）。
    return {
      decision: 'finish',
      pushPayloads: [buildScheduledPush('', build, finishMeta)],
    };
  }

  const lastIdx = segments.length - 1;
  return {
    decision: 'finish',
    pushPayloads: segments.map((seg, i) =>
      buildScheduledPush(seg.raw, build, i === lastIdx ? finishMeta : undefined, seg.sanitized),
    ),
  };
}

/**
 * 单段 → 老链路 scheduled push 形状（业务字段同 v1，可选多挂
 * metadata 追加键（directives / xhsSession）与 notification）。messageId/sessionId/
 * timestamp/messageIndex/totalMessages 由库的 sendHookPushPayloads 统一补齐/覆写。
 *
 * bannerBody = segment 的 sanitized 文本，塞进 notification.body 给 OS banner
 * 显示（[[SEND_EMOJI: x]] → [表情：x] 这类可读形态）；message 保留 raw 让客户端
 * applyAssistantPostProcessing 渲染卡片/表情。不带 notification.show —— SW 对
 * content push 的默认弹窗行为不变。
 */
function buildScheduledPush(
  message: string,
  build: PushBuildInput,
  extraMeta?: Record<string, unknown>,
  bannerBody?: string,
): Record<string, unknown> {
  const title = `来自 ${build.contactName}`;
  return {
    messageKind: 'content' as const,
    messageType: build.messageType,
    source: 'scheduled' as const,
    message,
    title,
    contactName: build.contactName,
    avatarUrl: build.avatarUrl,
    messageSubtype: 'chat',
    taskId: build.taskId,
    metadata: {
      ...build.metadata,
      ...(build.occurrenceMs != null ? { amsgOccurrenceMs: build.occurrenceMs } : {}),
      ...(extraMeta ?? {}),
    },
    ...(bannerBody !== undefined ? { notification: { title, body: bannerBody } } : {}),
  };
}
