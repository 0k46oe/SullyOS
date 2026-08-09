// worker/amsg/src/emotionEval.test.ts
//
// 占位符还原：前端把评估提示词里两段大文本（角色的 system prompt、完整对话历史）
// 留成占位符发上来，worker 用本次请求已有的消息填回原位。填错一个字，评估看到的
// 就不是角色真正看到的那份上下文，判出来的情绪对不上它刚说的话——而这种偏差在
// 界面上完全看不出来，只会表现为「情绪越来越不准」。
import { afterEach, describe, it, expect, vi } from 'vitest';

import { restoreEvalPrompt, runAmsgEmotionEval } from './emotionEval';

const TEMPLATE = [
  '## 角色此刻看到的完整上下文',
  '__EMOTION_EVAL_SYSTEM_PROMPT__',
  '## 完整对话历史',
  '__EMOTION_EVAL_HISTORY__',
].join('\n');

describe('restoreEvalPrompt', () => {
  it('system prompt 进第一个槽，其余消息按 [角色]: 正文 拼进第二个槽', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的。' },
    ], 'Nyah');

    expect(out).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(out).not.toContain('__EMOTION_EVAL_HISTORY__');
    expect(out).toContain('你是 Nyah。');
    expect(out).toContain('[用户]: 在吗');
    expect(out).toContain('[Nyah]: 在的。');
  });

  // String.replace 的第二个参数里，`$&`（整个匹配）、`$1`、`$'` 都是替换模式。
  // 用户设定里出现这些字符完全正常（写代码、写价格、写颜文字），naive 的
  // `.replace(槽位, 文本)` 会把它们当指令展开——system prompt 里凭空多出一串
  // 「__EMOTION_EVAL_SYSTEM_PROMPT__」，用户的原话反而丢了。函数式 replacer 才不会。
  it('设定里带 $& / $1 这类字符时逐字还原，不被当成替换模式展开', () => {
    const nastySystem = '规则：价格写成 $1，强调用 $& 包起来，别写 $`。';
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: nastySystem },
      { role: 'user', content: '懂了 $&' },
    ], 'Nyah');

    expect(out).toContain(nastySystem);
    expect(out).toContain('[用户]: 懂了 $&');
    // naive 实现下 $& 会被展开成占位符本身，这两条就是那种走样的样子
    expect(out).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(out).not.toContain('__EMOTION_EVAL_HISTORY__');
  });

  it('带图片的结构化消息拍平成「文字 [图片]」（跟本地那份逐字同款）', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这个' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ], 'Nyah');

    expect(out).toContain('[用户]: 看这个 [图片]');
    // 图片的 base64 一个字节都不该进评估请求（白烧 token，还可能撑爆请求体）
    expect(out).not.toContain('base64');
  });

  // 即时对话的时效块（现在几点、外面在下雨）是追加在末尾的 system 消息。
  // 它必须进历史，评估才知道角色刚才是对着什么时间说的那句话。
  it('末尾追加的 system 块进历史，标成 [系统]', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: '在吗' },
      { role: 'system', content: '【此刻的系统信息·仅你可见】\n现在是 2026年8月1日 早晨 08:00。' },
    ], 'Nyah');

    expect(out).toContain('[系统]: 【此刻的系统信息·仅你可见】');
    expect(out).toContain('现在是 2026年8月1日 早晨 08:00。');
  });

  it('第一条不是 system 时全都算历史（不硬吃掉一条当设定）', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'user', content: '在吗' },
    ], 'Nyah');

    expect(out).toContain('[用户]: 在吗');
    // 设定槽位填空串：没有就是没有，不能拿第一条用户消息顶上去
    expect(out).toContain('## 角色此刻看到的完整上下文\n\n## 完整对话历史');
  });
});

// 失败原因这句话最终要走 push 出门（评估失败信号带给客户端），里头绝不能有 apiKey。
// 个别中转会把整个请求（含 Authorization 头）回显在错误页里，所以打码必须先于截断：
// 先截的话，切口正好落在 key 中间时整串里查不到完整 key，半截凭据就原样带出去了。
describe('评估失败原因的脱敏', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('错误正文里的 apiKey 被截断切中也不许漏出半截（先打码后截断）', async () => {
    const apiKey = 'sk-secondary-0123456789abcdef0123456789abcdef';
    // 110 个填充字符 + key：120 字符的切口正好穿过 key 的前半截。
    const body = 'x'.repeat(110) + apiKey + ' tail';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => body,
    })));

    const outcome = await runAmsgEmotionEval(
      { prompt: TEMPLATE, api: { baseUrl: 'https://eval.example.com/v1', apiKey, model: 'eval-mini' } },
      [{ role: 'user', content: '在吗' }],
      'Nyah',
    );

    expect(outcome.raw).toBeNull();
    expect(outcome.error).toContain('副 API HTTP 401');
    expect(outcome.error).toContain('***');
    expect(outcome.error, 'key 的前缀一个字节都不许出门').not.toContain(apiKey.slice(0, 10));
  });
});
