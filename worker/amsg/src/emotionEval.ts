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
 * 失败绝不连累主回复——用户等的是那句话，情绪只是附赠；跑挂了就带一句短原因回去，
 * 让客户端能照实说明白，而不是丢一句「可查 worker 日志」。
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
const EMOTION_EVAL_TIMEOUT_MS = 120_000;

/**
 * 评估结果太大、一条 push 装不下时的旁路存储键（同 XHS 那套，见 amsgXhsSessionKey）。
 * push 里只留 `metadata.amsgEmotionRef` 指过来，客户端按键取回、用完即删。
 * 每任务固定一份、下次触发覆盖，所以没人来取也有上限，不需要额外的过期清理。
 */
export const amsgEmotionUpdateKey = (clientTaskId: string) => `emotion_update:${clientTaskId}`;

/** 这份配置能不能用来发请求（缺哪一样都发不出去）。 */
const isUsableEvalSpec = (spec: unknown): spec is AmsgEmotionEvalSpec => {
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

/**
 * 取出任务 metadata 里那份评估配置，**并就地从这个对象上删掉**（没有 / 不完整时返回 null，
 * 键照删——不完整的那份同样带着 apiKey）。
 *
 * 为什么是「取完就删」而不是只读：上游把解密后的 payload.metadata 按引用一路传下去——
 * `buildHookTask` 只做浅拷贝（`Object.freeze` 也只冻最外层），`onLLMOutput` 的
 * `ctx.metadata`、以及**没有 hook 接手时那条模板路径**读的都是同一个对象，而模板路径
 * 里 `push.metadata = args.metadata` 是直接引用赋值。也就是说，只要 `onBeforeFire`
 * 哪天在某个分支返回了 undefined（上游据此判「这次 hook 不接」），整份解密 metadata
 * 连副 API 的 apiKey 一起就会被塞进每一条推送。
 *
 * 在捕获点就地删掉，那条路径便无从可漏：这一跳的内存对象里根本没有这个键了。
 * D1 里的 encrypted_payload 一个字节没动，投递失败重跑时会重新解密出完整的一份，
 * 所以重试那一轮照样评估得了。
 *
 * 组 push 之前还有第二道 `stripEmotionEvalSpec`——两道都留着，别因为「上面已经删过」
 * 把哪一道拆了。
 */
export const takeEmotionEvalSpec = (
  metadata: Record<string, unknown> | undefined | null,
): AmsgEmotionEvalSpec | null => {
  const bag = metadata as Record<string, unknown> | undefined | null;
  if (!bag || typeof bag !== 'object') return null;
  const spec = bag.amsgEmotionEval;
  if (spec === undefined) return null;
  try {
    delete bag.amsgEmotionEval;
  } catch (error) {
    // 上游哪天把 metadata 也冻上了（严格模式下 delete 冻结属性会抛）。纵深防御的这一层
    // 自己绝不能变成故障源——记一笔就走，组 push 之前那道 strip 仍然拦得住。
    console.warn('[amsg:emotion] 评估配置删不掉（metadata 被冻结？），只剩组 push 前那道防线', error);
  }
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

/** 一次评估的结局：拿到原文，或者一句能给用户看的短失败原因。 */
export interface AmsgEmotionEvalOutcome {
  /** 评估模型的输出原文；没跑出来时为 null。 */
  raw: string | null;
  /** 没跑出来的原因（人话、一句话）；成功时为 null。 */
  error: string | null;
}

/** 报错正文最多带回这么长——够定位是限流还是鉴权就行，不是日志转发通道。 */
const ERROR_SNIPPET_MAX = 120;

/**
 * 从失败响应里摘一句能给用户看的原因。
 *
 * **绝不能带出 apiKey**：个别中转会把整个请求（含 Authorization 头）回显在错误页里，
 * 而这句话最终要走 push 出门。摘之前先按 key 本身过一遍，命中就打码。
 */
const describeEvalFailure = (status: number, body: string, apiKey: string): string => {
  let snippet = body.replace(/\s+/g, ' ').trim().slice(0, ERROR_SNIPPET_MAX);
  if (apiKey && snippet.includes(apiKey)) snippet = snippet.split(apiKey).join('***');
  return `副 API HTTP ${status}${snippet ? `：${snippet}` : ''}`;
};

/**
 * 跑一次评估。成功给原文（解析交给客户端的 applyEmotionEvalRaw，与本地路径共用同一套
 * 容错），失败给一句短原因——它会跟着「评估有结论了」的信号回到客户端，替掉过去那句
 * 「可查 worker 日志」。用户自己部署的 worker，日志不是人人都会看。
 *
 * `chatMessages` 要传**主生成真正看到的那一串**（含末尾追加的时效块），
 * 少了那一块评估模型连现在几点都不知道，判出来的情绪会对不上角色刚说的话。
 */
export const runAmsgEmotionEval = async (
  spec: AmsgEmotionEvalSpec,
  chatMessages: Array<{ role: string; content: unknown }>,
  charName: string,
  timeoutMs: number = EMOTION_EVAL_TIMEOUT_MS,
): Promise<AmsgEmotionEvalOutcome> => {
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
      // 正文可能是 HTML 错误页，截一小段够定位即可（与 instant push worker 同一套）。
      let body = '';
      try { body = await res.text(); } catch { /* 读不出正文就只报状态码 */ }
      console.warn('[amsg:emotion] 副 API 拒了这次评估（主回复不受影响）', res.status);
      return { raw: null, error: describeEvalFailure(res.status, body, spec.api.apiKey) };
    }
    const data = await res.json() as any;
    // 个别中转把全部输出塞进 reasoning_content 而 content 留空——与客户端
    // utils/emotionApply.ts 的 extractAssistantText 同一套兜底。
    const message = data?.choices?.[0]?.message;
    const raw = flattenContent(message?.content)
      || (typeof message?.reasoning_content === 'string' ? message.reasoning_content : '');
    if (!raw.trim()) {
      return {
        raw: null,
        error: `评估模型没有输出内容（finish_reason: ${data?.choices?.[0]?.finish_reason ?? '?'}）`,
      };
    }
    return { raw, error: null };
  } catch (error) {
    console.warn('[amsg:emotion] 评估失败（主回复不受影响）', error);
    // 只带异常名/消息，不带栈：这句要走 push 出门，短一点、也别把内部路径抖出去。
    const reason = controller.signal.aborted
      ? `评估超时（${Math.round(timeoutMs / 1000)} 秒没回来）`
      : `评估请求没发出去：${(error instanceof Error ? error.message : String(error)).slice(0, ERROR_SNIPPET_MAX)}`;
    return { raw: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
};
