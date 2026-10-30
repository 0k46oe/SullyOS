import { describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, Message, UserProfile } from '../types';
import { ChatPrompts } from './chatPrompts';
import { cleanApiMessages } from './promptMessageCleanup';
import { extractSourceFile, materializeArtifact, parseArtifactBlocks } from '../features/collaboration/files';
import { buildCollaborationModelMessages } from '../features/collaboration/context';
import { applyAssistantPostProcessing, type PostProcessCtx } from './applyAssistantPostProcessing';
import { CollaborationStore } from '../features/collaboration/store';
import { DB } from './db';
import { computeStreamPreviewBubbles } from './streamPreview';

const preset = JSON.stringify({ temperature: 0.8, prompts: [{ identifier: 'main', content: '<think>literal</think> %%BILINGUAL%% <翻译><原文>一</原文><译文>二</译文></翻译> {{char}} [[ACTION:POKE]]' }], prompt_order: [] }, null, 2);
const actor = { id: 'json-context', name: '测试角色', timeAwarenessEnabled: false, contextRangeMode: 'manual', contextRangePolicyVersion: 1, contextLimit: 200 } as CharacterProfile;
const user = { name: '本人' } as UserProfile;
const fileMessage = (role: 'user' | 'assistant'): Message => ({ id: 1, charId: actor.id, role, type: 'collaboration_file', content: '[JSON 文件：预设.json]', timestamp: 1, metadata: { fileName: '预设.json', format: 'json', jsonKindLabel: 'SillyTavern Chat Completion 预设', extractedText: preset } });
const ctx = (id: string): PostProcessCtx => ({
  char: { id, name: '测试角色', scheduleFeatureEnabled: false } as CharacterProfile, userProfile: user,
  emojis: [], contextMsgs: [], fullMessages: [], initialData: {}, historyMsgCount: 0,
  xhsCaches: { xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(), commentAuthorNameCache: new Map(), commentParentIdCache: new Map() },
  api: { baseUrl: 'http://localhost:0', headers: {}, effectiveApi: { baseUrl: 'http://localhost:0', model: 'test', apiKey: '' } },
  hooks: { setMessages: vi.fn(), addToast: vi.fn() }, instantRender: true, skipSecondPassLLM: true,
});

describe('JSON read/write in both chat windows', () => {
  it.each(['user', 'assistant'] as const)('keeps %s file content intact through normal-chat cleanup', role => {
    const history = ChatPrompts.buildMessageHistory([fileMessage(role)], 100, actor, user, []);
    const cleaned = cleanApiMessages(history.apiMessages);
    const serialized = JSON.stringify(cleaned);
    const content = cleaned[0].content.map((part: any) => part.text).join('\n');
    expect(content).toContain(preset);
    expect(content).toContain('SillyTavern Chat Completion 预设');
    expect(content).toContain(role === 'user' ? '用户发送了 JSON' : '你向用户交付了 JSON');
    expect(serialized).not.toContain('collaborationAssetId');
  });

  it('reads a preset into the actual collaboration request, including MIME-only files', async () => {
    const source = new File([preset], 'preset', { type: 'application/json' });
    const extracted = await extractSourceFile(source);
    expect(extracted.jsonKind).toBe('tavern-preset');
    const messages = buildCollaborationModelMessages('', [{
      id: 'msg', sessionId: 'session', role: 'user', content: '读取这个预设', createdAt: 1,
      attachments: [{ id: 'attachment', assetId: 'asset', kind: 'source', name: source.name, mimeType: source.type, size: source.size, createdAt: 1, extractedText: extracted.text }],
    }]);
    const content = messages.map(message => message.content).join('\n');
    expect(content).toContain(preset);
    expect(content).toContain('SillyTavern Chat Completion 预设');
  });

  it('creates a downloadable normal-chat file before tags in the file can execute', async () => {
    const id = 'json-output-file';
    const response = ['文件给你。', '```artifact', 'title: 新预设.json', 'format: json', '---', preset, '```'].join('\n');
    await applyAssistantPostProcessing(response, ctx(id));
    const rows = await DB.getRecentMessagesByCharId(id, 20);
    const file = rows.find(row => row.type === 'collaboration_file')!;
    expect(file.metadata.fileName).toBe('新预设.json');
    expect(file.role).toBe('assistant');
    const blob = await CollaborationStore.getAsset(file.metadata.collaborationAssetId);
    expect(await blob!.text()).toBe(preset);
    expect(blob!.type).toContain('application/json');
    expect(rows.filter(row => row.type === 'interaction')).toHaveLength(0);
    expect(rows.filter(row => row.type === 'text').map(row => row.content)).toEqual(['文件给你。']);
    // Blobs used by ordinary chat are included in system backup as well.
    const backup = await CollaborationStore.exportBackup(true);
    expect(backup.assets?.some(asset => asset.id === file.metadata.collaborationAssetId)).toBe(true);
  });

  it('materializes valid collaboration JSON and rejects broken JSON', async () => {
    const block = ['```artifact', 'title: 预设', 'format: json', '---', preset, '```'].join('\n');
    const parsed = parseArtifactBlocks(block);
    const result = await materializeArtifact(parsed.artifacts[0]);
    expect(result.attachment.name).toBe('预设.json');
    expect(await result.blob.text()).toBe(preset);
    await expect(materializeArtifact({ title: '坏文件', format: 'json', content: '{broken}' })).rejects.toThrow('JSON 格式无效');
  });

  it('does not flash JSON bodies as streamed bubbles, including incomplete fences', () => {
    const source = ['完成', '```artifact', 'title: 预设', 'format: json', '---', preset].join('\n');
    for (const suffix of ['', '\n```', '\n```\n收好了']) {
      const bubbles = computeStreamPreviewBubbles(source + suffix);
      expect(bubbles.join('\n')).not.toContain('temperature');
      expect(bubbles.join('\n')).not.toContain('format:');
      expect(bubbles[0]).toBe('完成');
    }
    expect(computeStreamPreviewBubbles('完成\n``')).toEqual(['完成']);
  });
});
