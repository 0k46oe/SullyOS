/**
 * 即时对话的云端情绪评估。
 *
 * 用户按下发送那一刻，前端把「评估提示词模板 + 副 API 凭据」一起交给云端；这一轮的
 * 主回复在 worker 里生成，情绪评估也在这里跑完，结果随最后一条推送回去。发完就能关
 * 页面——过去评估是在浏览器里 fire-and-forget 跑的，页面一关情绪底色就停更了。
 *
 * 模板是前端用 `buildEmotionEvalPrompt(..., includeContext=false, ...)` 生成的：两段
 * 大文本（角色的 system prompt、完整对话历史）留成占位符，由本次请求已有的 chat 段
 * 还原回原位。这样上下文不必在请求体里重复发一份，输出又与本地逐字对齐。
 *
 * 还原规则与 instant push worker 的 `runEmotionEval`（worker/instant-push/src/index.ts）
 * **逐字同款**——两边吃的是同一个模板，格式一漂输出就变味。之所以复制一份而不是共享：
 * 两个 worker 是各自打包部署的 bundle，共享只能走 utils/ 叶子，而这段逻辑贴着 amsg 的
 * chat 段形状，放在 amsg 侧更贴。
 *
 * 失败一律返回 null，绝不连累主回复——用户等的是那句话，情绪只是附赠。
 *
 * 零浏览器依赖（这份代码会被打进 worker bundle）。
 */

/** 前端塞进任务 metadata.amsgEmotionEval 的那份评估配置。 */
export interface AmsgEmotionEvalSpec {
  /** 带两个占位符的评估提示词模板。 */
  prompt: string;
  /** 副 API 凭据（没单独配就是主 API 那一份）。 */
  api: { baseUrl: string; apiKey: string; model: string };
}

const SYSTEM_SLOT = '__EMOTION_EVAL_SYSTEM_PROMPT__';
const HISTORY_SLOT = '__EMOTION_EVAL_HISTORY__';

/** 单次评估请求的上限；副 API 卡住的话，主回复不该跟着一起被扣在这儿。 */
export const EMOTION_EVAL_TIMEOUT_MS = 120_000;

/**
 * 评估结果太大、一条 push 装不下时的旁路存储键（同 XHS 那套，见 amsgXhsSessionKey）。
 * push 里只留 `metadata.amsgEmotionRef` 指过来，客户端按键取回、用完即删。
 * 每任务固定一份、下次触发覆盖，所以没人来取也有上限，不需要额外的过期清理。
 */
export const amsgEmotionUpdateKey = (clientTaskId: string) => `emotion_update:${clientTaskId}`;

/** 这份配置能不能用来发请求（缺哪一样都发不出去）。 */
export const isUsableEvalSpec = (spec: unknown): spec is AmsgEmotionEvalSpec => {
  const s = spec as AmsgEmotionEvalSpec | undefined;
  return !!s
    && typeof s.prompt === 'string' && !!s.prompt
    && !!s.api
    && typeof s.api.baseUrl === 'string' && !!s.api.baseUrl
    && typeof s.api.model === 'string' && !!s.api.model;
};

/**
 * 从要交给推送的 metadata 里摘掉评估配置。**红线**：它里头是用户副 API 的 apiKey。
 *
 * 任务 metadata 走的是端到端加密的信封，放在那儿是安全的；而推送 payload 出了这台
 * worker 就归推送服务管了，凭据跟着走等于把用户的副 API 送人。组 push 的那一层
 * （agentic 的 buildScheduledPush）把 metadata 整个摊开带走，所以只能在喂进去之前摘。
 */
export const stripEmotionEvalSpec = (
  metadata: Record<string, unknown> | undefined | null,
): Record<string, unknown> => {
  const { amsgEmotionEval: _secret, ...rest } = (metadata ?? {}) as Record<string, unknown>;
  return rest;
};

/** 任务 metadata 里那份评估配置（没有 / 不完整时为 null）。 */
export const readEmotionEvalSpec = (
  metadata: Record<string, unknown> | undefined | null,
): AmsgEmotionEvalSpec | null => {
  const spec = (metadata as Record<string, unknown> | undefined)?.amsgEmotionEval;
  return isUsableEvalSpec(spec) ? spec : null;
};

/**
 * 消息 content → 一行文本。结构化分段（带图片的消息）拍平成「文字 [图片]」。
 * 与本地 buildEmotionEvalPrompt 的 recentLines 同款：用空格连接、空段丢掉。
 */
const flattenContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part?.type === 'text'
        ? (part.text || '')
        : (part?.type === 'image_url' ? '[图片]' : '')))
      .filter(Boolean)
      .join(' ');
  }
  return '';
};

/**
 * 把模板里的两个占位符用本次请求的消息还原掉。
 *
 * - `messages[0]`（role=system）= 本地的 mainSystemPrompt
 * - `messages[1..]` = 本地的 cleanedApiMessages，拼成 `[用户]: …` / `[角色名]: …` / `[系统]: …`
 *
 * 用函数式 replacer：system prompt 和对话里出现 `$&`、`$1` 这类字符时，
 * String.replace 会把它们当成替换模式解析，评估看到的就不是原话了。
 */
export const restoreEvalPrompt = (
  template: string,
  chatMessages: Array<{ role: string; content: unknown }>,
  charName: string,
): string => {
  const messages = Array.isArray(chatMessages) ? chatMessages : [];
  let systemPromptText = '';
  let conversation = messages;
  if (messages.length > 0 && messages[0]?.role === 'system') {
    systemPromptText = flattenContent(messages[0].content);
    conversation = messages.slice(1);
  }
  const recentLines = conversation
    .map((m) => {
      const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? charName : '系统');
      return `[${role}]: ${flattenContent(m.content)}`;
    })
    .join('\n');
  return String(template)
    .replace(SYSTEM_SLOT, () => systemPromptText)
    .replace(HISTORY_SLOT, () => recentLines);
};

/**
 * 跑一次评估，返回模型输出的原文（解析交给客户端的 applyEmotionEvalRaw，
 * 与本地路径共用同一套容错）。跑不出来一律 null。
 *
 * `chatMessages` 要传**主生成真正看到的那一串**（含末尾追加的时效块），
 * 少了那一块评估模型连现在几点都不知道，判出来的情绪会对不上角色刚说的话。
 */
export const runAmsgEmotionEval = async (
  spec: AmsgEmotionEvalSpec,
  chatMessages: Array<{ role: string; content: unknown }>,
  charName: string,
  timeoutMs: number = EMOTION_EVAL_TIMEOUT_MS,
): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = String(spec.api.baseUrl).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${spec.api.apiKey || 'sk-none'}`,
      },
      body: JSON.stringify({
        model: spec.api.model,
        messages: [{ role: 'user', content: restoreEvalPrompt(spec.prompt, chatMessages, charName) }],
        temperature: 0.85,
        // 显式给足输出额度：部分中转不传 max_tokens 时默认很小，评估输出很长，
        // 会被截成半截 JSON（与 instant push worker 同一个数）。
        max_tokens: 8000,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('[amsg:emotion] 副 API 拒了这次评估（主回复不受影响）', res.status);
      return null;
    }
    const data = await res.json() as any;
    // 个别中转把全部输出塞进 reasoning_content 而 content 留空——与客户端
    // utils/emotionApply.ts 的 extractAssistantText 同一套兜底。
    const message = data?.choices?.[0]?.message;
    const raw = flattenContent(message?.content)
      || (typeof message?.reasoning_content === 'string' ? message.reasoning_content : '');
    return raw.trim() ? raw : null;
  } catch (error) {
    console.warn('[amsg:emotion] 评估失败（主回复不受影响）', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
};
