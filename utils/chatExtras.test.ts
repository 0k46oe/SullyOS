import { describe, expect, it } from 'vitest';
import { extractChatExtras } from './chatExtras';
describe('extractChatExtras', () => {
  it('extracts one action and one image tag without leaking them', () => {
    expect(extractChatExtras('<线上动描>他抬眼一笑</线上动描>你好<生成图片>窗边咖啡</生成图片>')).toEqual({ text: '你好', action: '他抬眼一笑', image: '窗边咖啡' });
  });
  it('ignores tags inside code and thoughts', () => {
    const fence = String.fromCharCode(96).repeat(3);
    const source = fence + '<生成图片>code</生成图片>' + fence + '<think><生成图片>thought</生成图片></think>正文';
    expect(extractChatExtras(source)).toEqual({ text: source });
  });
});

