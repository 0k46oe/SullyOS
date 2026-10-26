import { isSseResponseText, safeResponseJson, type StreamHooks } from './safeApi';

type StreamBlock = { value: Record<string, any>; partialJson: string; stopped: boolean };

/** Native Messages SSE, assembled before the existing OpenAI-shaped response conversion. */
export async function readAnthropicResponse(
  response: Response,
  hooks?: StreamHooks,
  timing?: { firstDeltaMs?: number },
  startedAt?: number,
  signal?: AbortSignal | null,
): Promise<any> {
  let message: any;
  const blocks = new Map<number, StreamBlock>();
  let fullText = '';
  let firstDelta = false;
  let finished = false;
  let pending = '';
  const state: { mode: 'undecided' | 'sse' | 'raw' } = { mode: 'undecided' };
  let eventName = '';
  let dataLines: string[] = [];
  const fail = (detail: string): never => { throw new Error(`Anthropic 流式响应错误：${detail}`); };
  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
  };
  const emit = (text: string) => {
    if (!text) return;
    fullText += text;
    if (!firstDelta) {
      firstDelta = true;
      if (timing && startedAt != null) timing.firstDeltaMs = Date.now() - startedAt;
      try { hooks?.onFirstDelta?.(); } catch { /* UI callbacks must not corrupt the response. */ }
    }
    try { hooks?.onDelta?.(text, fullText); } catch { /* Keep consuming valid provider output. */ }
  };
  const dispatch = () => {
    if (!dataLines.length || finished) { dataLines = []; eventName = ''; return; }
    let event: any;
    try { event = JSON.parse(dataLines.join('\n')); }
    catch { fail('事件包含无效 JSON，请重试'); }
    dataLines = [];
    const type = event.type || eventName;
    eventName = '';
    if (type === 'error') fail(event.error?.message || event.error?.type || '接口返回错误');
    if (type === 'ping') return;
    if (type === 'message_start') {
      if (message || !event.message || !Array.isArray(event.message.content)) fail('message_start 格式不正确');
      message = { ...event.message, content: [], usage: { ...event.message.usage } };
      event.message.content.forEach((value: Record<string, any>, index: number) => {
        blocks.set(index, { value: { ...value }, partialJson: '', stopped: true });
        if (value.type === 'text') emit(value.text || '');
      });
    } else if (type === 'content_block_start') {
      if (!message || !Number.isInteger(event.index) || event.index < 0 || blocks.has(event.index) || !event.content_block?.type) fail('内容块起始事件不完整');
      const value = { ...event.content_block };
      blocks.set(event.index, { value, partialJson: '', stopped: false });
      if (value.type === 'text') emit(value.text || '');
    } else if (type === 'content_block_delta') {
      const block = blocks.get(event.index);
      if (!block || block.stopped) fail('内容增量缺少对应的起始事件');
      const delta = event.delta;
      if (delta?.type === 'text_delta') {
        if (block!.value.type !== 'text' || typeof delta.text !== 'string') fail('文字增量格式不正确');
        block!.value.text = (block!.value.text || '') + delta.text;
        emit(delta.text);
      } else if (delta?.type === 'input_json_delta') {
        if (block!.value.type !== 'tool_use' || typeof delta.partial_json !== 'string') fail('工具参数增量格式不正确');
        block!.partialJson += delta.partial_json;
      }
      // Unknown future delta types are ignored, as required by the provider's SSE contract.
    } else if (type === 'content_block_stop') {
      const block = blocks.get(event.index);
      if (!block || block.stopped) fail('内容块结束事件不完整');
      if (block!.partialJson) {
        try { block!.value.input = JSON.parse(block!.partialJson); }
        catch { fail('工具参数 JSON 未完整返回'); }
      }
      block!.stopped = true;
    } else if (type === 'message_delta') {
      if (!message) fail('缺少 message_start');
      if (event.delta?.stop_reason !== undefined) message.stop_reason = event.delta.stop_reason;
      if (event.delta?.stop_sequence !== undefined) message.stop_sequence = event.delta.stop_sequence;
      if (event.usage) message.usage = { ...message.usage, ...event.usage };
    } else if (type === 'message_stop') {
      if (!message || [...blocks.values()].some(block => !block.stopped)) fail('回复未完整结束');
      message.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block.value);
      finished = true;
    }
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    const separator = value.indexOf(':');
    const field = separator < 0 ? value : value.slice(0, separator);
    const rest = separator < 0 ? '' : value.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') dataLines.push(rest);
    else if (field === 'event') eventName = rest;
  };
  const consume = (text: string) => {
    pending += text;
    if (state.mode === 'undecided') {
      if (!pending.trim()) return;
      if (isSseResponseText(pending, response.headers.get('content-type'))) state.mode = 'sse';
      else if (/^[{["<]/.test(pending.trimStart()) || pending.includes('\n')) state.mode = 'raw';
      else return; // The SSE field name itself can be split across byte chunks.
    }
    if (state.mode !== 'sse') return;
    let newline: number;
    while (!finished && (newline = pending.indexOf('\n')) >= 0) {
      const next = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      line(next);
    }
  };
  const reader = response.body?.getReader?.();
  const abort = () => { void reader?.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    throwIfAborted();
    if (reader) {
      const decoder = new TextDecoder();
      while (!finished) {
        const { done, value } = await reader.read();
        throwIfAborted();
        if (done) { consume(decoder.decode()); break; }
        consume(decoder.decode(value, { stream: true }));
      }
    } else consume(await response.text());
    throwIfAborted();
    if (state.mode === 'sse') {
      if (!finished) {
        if (pending) line(pending.replace(/\r$/, ''));
        dispatch(); // Accept a final event without a trailing blank line.
      }
      if (!finished) fail('连接提前结束，未收到 message_stop；本次不会自动重发');
      return message;
    }
    // A proxy can ignore stream:true and return ordinary JSON, even with a mislabeled MIME type.
    return safeResponseJson(new Response(pending, { status: response.status, headers: response.headers }));
  } finally {
    signal?.removeEventListener('abort', abort);
    if (reader) {
      try { await reader.cancel(); } catch { /* Preserve the original stream/error result. */ }
      reader.releaseLock();
    }
  }
}
