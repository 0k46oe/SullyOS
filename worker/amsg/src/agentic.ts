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
import type { ToolCallRecord } from '../../../utils/agenticToolFeedback';
import {
  extractTextFakedMcpCalls,
  stripTextFakedMcpCalls,
  type McpFireServer,
  type McpResolvedToolCore,
} from '../../../utils/mcpFireCore';
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
  /**
   * 本次 fire 已经跑过的工具调用。两个用处：回喂时把清单报给模型（「这些查过了」），
   * 以及拦住同名同参的重复调用（见 executeToolCalls）。跨轮累积，fire 结束随 scratch 丢弃。
   */
  toolCalls: ToolCallRecord[];
  /** 被打回的重复调用次数（executeToolCalls 累加）。到阈值就收尾，见 MAX_DUPLICATE_TOOL_CALLS。 */
  duplicateToolCalls: number;
}

export const createFireSessionState = (): FireSessionState => ({
  narrations: [],
  toolCalls: [],
  duplicateToolCalls: 0,
});

/**
 * 连着重复请求同一个工具这么多次，就不再陪它转了，直接收尾把已有内容发出去。
 *
 * 光把重复调用打回去只省下了网络请求，模型该转还是转：提示词里但凡有一句常驻的
 * 「每轮先去查 X」，回喂里说什么都盖不过它——实测就是连着五轮都在请求同一个 recall，
 * 最后撞上轮次上限抛 AGENTIC_LOOP_EXCEEDED，任务不出清、下一分钟整条从头重跑。
 *
 * 收尾比转到上限好得多：用户至少收到角色已经写出来的那部分，任务也正常出清。
 * 阈值取 2 —— 第一次重复可能只是模型确认一下，连着两次就是真卡住了。
 */
export const MAX_DUPLICATE_TOOL_CALLS = 2;

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
  occurrenceMs: number;
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

/**
 * 从 finish 时的全部 directives 里挑出 XHS 引用，组客户端重放要的最小数据包：
 *   - xhs_share 的 idx → 对应笔记（越界/编造的序号取不到就跳过，客户端照旧警告）；
 *   - xhs_like / fav / comment / reply 的 noteId → 对应 xsecToken。
 * 没有任何 XHS 引用（或引用全落空）→ null，metadata 不多挂键。
 *
 * 这里**不限张数**：角色说分享了几张就带几张。塞不塞得进一条 push 是 index.ts 组装时
 * 按真实字节预算算的，超出的部分旁路存 client_state（见 offloadOversizedPush），
 * 客户端取回后照样出卡——不会出现「说分享了 6 张只出来 4 张」。
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
  }
  const pickedTokens = (xsecTokens ?? []).filter(([noteId]) => refNoteIds.has(noteId));

  if (pickedNotes.length === 0 && pickedTokens.length === 0) return null;
  return { notes: pickedNotes, xsecTokens: pickedTokens };
}

export type RoundDecision =
  | { decision: 'tool-request'; toolCalls: ToolCall[] }
  | { decision: 'finish'; pushPayloads: Array<Record<string, unknown>> }
  | { decision: 'skip-push' };

/** 本轮的通用 MCP 识别输入（没配 MCP 的角色不传，行为与改动前完全一致）。 */
export interface McpRoundInput {
  resolve: Map<string, McpResolvedToolCore<McpFireServer>>;
  /** 本轮 LLM 响应里已按 mcp__ 前缀过滤好的 native tool_calls；文本模式/无调用时缺省。 */
  nativeToolCalls?: ToolCall[];
}

/**
 * 处理一轮 LLM 输出（入参已 stripReasoningTags）：
 *   - 有数据标签（或本轮有 MCP 调用）→ 原始旁白（prefix）暂存，返回 tool-request；
 *   - 无数据标签 → finish：把全部中间轮旁白 + 本轮正文**拼回一份全文**统一
 *     classify（跨轮被劈开的副作用标签块在这里合体），干净正文经
 *     sanitizeIntoSegments 分段（与 instant push / 客户端 chatParser.chunkText
 *     同一份：按换行切、[[...]] / [html] / <翻译> / <语音> 等标签块保持原子），
 *     每段一条 push；全部 directives 挂最后一条的 metadata；
 *     全程无正文且无副作用 → skip-push。
 *
 * 通用 MCP 的调用识别是两层（native tool_calls + 正文协议），与前台同构，见函数体开头。
 */
export function processLLMRound(
  state: FireSessionState,
  llmOutputText: string,
  build: PushBuildInput,
  mcp?: McpRoundInput | null,
): RoundDecision {
  // 通用 MCP 两层识别（与前台同构）：native tool_calls 优先；没有 native 时
  // 用前台「兼容模式」同一个解析器从正文抠 tool_name({...})。两种来源都可能
  // 与数据标签同轮出现，最终合并成同一个 tool-request，executeToolCalls 按
  // mcp__ 前缀分流。正文里出现过的调用语法一律剥掉——它不能进旁白/推送。
  // 正文解析认 mcp__ 前缀名（native 模式下模型在 tools 数组里见到的名字带前缀，
  // 掉格式写进正文时写的也是它）——core 的 alsoMatchPrefix 选项负责，exposedName 回裸名。
  const nativeToolCalls = mcp?.nativeToolCalls ?? [];
  const textCalls = mcp?.resolve.size
    ? extractTextFakedMcpCalls(llmOutputText, mcp.resolve, { alsoMatchPrefix: 'mcp__' })
    : [];
  const scanText = textCalls.length ? stripTextFakedMcpCalls(llmOutputText, textCalls) : llmOutputText;
  // native 在场时正文抠出来的不再入列（同一意图大概率两处都写了；库只给 assistant
  // 消息合并 decision 里的 toolCalls，native 已含语义）。语法照剥。
  const mcpToolCalls: ToolCall[] = nativeToolCalls.length > 0
    ? nativeToolCalls
    : textCalls.map((c, i) => ({
        // id 只需在一轮的 assistant/tool 消息配对里唯一；用累计工具数做轮间区分度。
        id: `mcp_${state.toolCalls.length}_${i}`,
        type: 'function',
        // exposedName 恒为裸名（alsoMatchPrefix 的命中也回裸名），统一补前缀即可。
        function: { name: `mcp__${c.exposedName}`, arguments: JSON.stringify(c.args) },
      }));

  const result = classifyLLMOutput(scanText);
  const isToolRound = result.kind === 'tool-request' || mcpToolCalls.length > 0;

  if (isToolRound) {
    // prefix = 旁白 + 可能只写了一半的副作用标签块。这里不剥不结构化——
    // 等 finish 拼回全文统一扫（见 FireSessionState.narrations 注释）。
    // MCP-only 轮没有数据标签，整段剥净后的文本都是旁白（与 tag 轮的 prefix 同角色）。
    const narration = result.kind === 'tool-request' ? result.prefix : scanText;
    if (narration.trim()) state.narrations.push(narration);
    // 已经连着打回这么多次重复调用了，说明模型卡在同一个工具上出不来。不再给它下一轮，
    // 就用手上这些内容收尾——转到轮次上限的话整条任务会失败重跑，用户一个字都收不到。
    if (state.duplicateToolCalls < MAX_DUPLICATE_TOOL_CALLS) {
      return {
        decision: 'tool-request',
        toolCalls: result.kind === 'tool-request' ? [...result.toolCalls, ...mcpToolCalls] : mcpToolCalls,
      };
    }
  }

  // 拼回全文再扫一次。中间轮 prefix 里不含数据标签（prefix 定义即「首个数据标签
  // 之前」），本轮正文也没有（有就走上面 tool-request 分支了），所以这次分类必然
  // 落 finish；万一未来 classifier 语义变化落了 tool-request，取其 prefix 兜底，
  // 不让 fire 链在 finish 关头断掉。
  // 没有旁白（一轮直出，最常见）时全文就是本轮正文，同样的输入不必再扫一遍。
  // 从上面 tool-request 分支穿透下来收尾时，本轮的正文已经进过 narrations 了，
  // 这里再拼一次 llmOutputText 就会重复一段（而且它还带着那个转不出来的数据标签）。
  const thisRound = isToolRound ? '' : scanText;
  const fullText = [...state.narrations, thisRound]
    .filter((part) => part.trim().length > 0)
    .join('\n');
  // result 是在 scanText（剥掉 MCP 调用语法之后的文本）上算的，比对基准必须跟着换，
  // 否则 MCP 轮穿透到收尾时会拿错缓存。没有 MCP 参与时 scanText === llmOutputText，
  // 这里与改动前完全一致。
  const finalScan = fullText === scanText ? result : classifyLLMOutput(fullText);
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
      amsgOccurrenceMs: build.occurrenceMs,
      ...(extraMeta ?? {}),
    },
    ...(bannerBody !== undefined ? { notification: { title, body: bannerBody } } : {}),
  };
}
