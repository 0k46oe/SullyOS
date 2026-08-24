import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReplySnapshotContent } from './applyAssistantPostProcessing';
import { isBlobRef } from './blobRef';

// 角色回复里带 [[QUOTE: ...]] 时，会把「被引用的那条」的内容快照写进 replyTo.content。
//
// 这里原来是无脑截前 10 个字。图片改存 `blobref:<id>` 令牌之后，这 10 个字**正好**是
// `blobref:b_` —— 令牌前缀加上 SDK 生成 id 的第一个字符。
//
// messages 表是 Blob 孤儿清理的引用面（utils/blobGc.ts 把每条消息 JSON.stringify 后
// 交给 SDK 扫）。SDK 从这半截前缀提取出来的短 id 是它生成的**每一个** id 的公共前缀，
// 于是它的边界歧义安全阀判定「引用面像是被截断过，不安全」→ 整库豁免，一个 Blob 都不删，
// 而且不报任何错（宿主唯一能察觉的信号是 runGc 返回值里的 keptBoundary）。
//
// 也就是说：一条引用回复落到图片消息上，就能把整个孤儿清理静默关掉。

const BLOB_TOKEN = 'blobref:b_0123456789abcdef';
const DATA_URL = 'data:image/png;base64,' + 'A'.repeat(400);
const HTTP_URL = 'https://cdn.example.com/emoji/aaaaaaaaaaaa.png';

describe('引用回复的内容快照', () => {
    it('fixture 用的确实是 SDK 认的令牌形态', () => {
        expect(isBlobRef(BLOB_TOKEN)).toBe(true);
        // 这就是坑本身：截 10 个字 = 每个 SDK id 的公共前缀
        expect(BLOB_TOKEN.slice(0, 10)).toBe('blobref:b_');
    });

    it('引用一条 blobref 图片消息，写进快照的不是被截断的令牌', () => {
        const snapshot = buildReplySnapshotContent({ type: 'image', content: BLOB_TOKEN });
        expect(snapshot).not.toContain('blobref');
        expect(snapshot).toBe('[图片]');
    });

    it('没标 type、值本身是令牌时也认得出来（兜底分支会取到任意最后一条 user 消息）', () => {
        const snapshot = buildReplySnapshotContent({ content: BLOB_TOKEN });
        expect(snapshot).not.toContain('blobref');
        expect(snapshot).toBe('[图片]');
    });

    it('旧的 data: / 图床 URL 一样不进快照', () => {
        expect(buildReplySnapshotContent({ type: 'image', content: DATA_URL })).toBe('[图片]');
        expect(buildReplySnapshotContent({ content: DATA_URL })).toBe('[图片]');
        expect(buildReplySnapshotContent({ content: HTTP_URL })).toBe('[图片]');
    });

    it('表情包给自己的占位符', () => {
        expect(buildReplySnapshotContent({ type: 'emoji', content: BLOB_TOKEN })).toBe('[表情包]');
    });

    it('普通文字还是老样子：长的截 10 个字，短的原样', () => {
        expect(buildReplySnapshotContent({ type: 'text', content: '今天天气真好我们出去走走吧' })).toBe('今天天气真好我们出去...');
        expect(buildReplySnapshotContent({ type: 'text', content: '好呀' })).toBe('好呀');
    });
});

describe('引用解析的调用点', () => {
    const source = readFileSync(path.resolve(__dirname, './applyAssistantPostProcessing.ts'), 'utf8');

    it('resolveQuoteTarget 走快照函数，不再自己截 10 个字', () => {
        expect(source).toContain('content: buildReplySnapshotContent(targetMsg)');
        expect(source).not.toMatch(/targetMsg\.content\.slice\(0,\s*10\)\s*\+\s*'\.\.\.'/);
    });

    it('文件里没有别的地方往 replyTo 里塞裸截断的 content', () => {
        // replyTo 只有 aiReplyTarget / chunkReplyTarget 两个来源，都出自 resolveQuoteTarget
        const producers = source.match(/=\s*resolveQuoteTarget\(/g) || [];
        expect(producers).toHaveLength(2);
        expect(source).not.toMatch(/replyTo:\s*\{/);
    });
});
