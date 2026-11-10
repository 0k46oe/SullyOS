import { describe, it, expect, vi } from 'vitest';
import { applyAssistantPostProcessing } from './applyAssistantPostProcessing';
import { DB } from './db';

const mocks = vi.hoisted(() => ({ image: vi.fn(), save: vi.fn() }));
vi.mock('./chatImageWithFallback', () => ({ generateImageWithFallback: mocks.image }));
vi.mock('./chatImageLibrary', () => ({ savePendingAutomaticImage: mocks.save }));

describe('automatic image delivery', () => {
    it('shows the image while gallery thumbnail processing is still pending', async () => {
        let release!: () => void;
        const galleryPending = new Promise<void>(resolve => { release = resolve; });
        let galleryStarted!: () => void;
        const started = new Promise<void>(resolve => { galleryStarted = resolve; });
        mocks.image.mockResolvedValue({ imageRef: 'image-ref', failed: false });
        mocks.save.mockImplementation(() => { galleryStarted(); return galleryPending; });
        const charId = `image-delivery-${Date.now()}`;
        const setMessages = vi.fn();
        const run = applyAssistantPostProcessing('', {
            char: { id: charId, name: '角色', chatImageGenerationEnabled: true, imageGenerationSelection: { provider: 'oai' } },
            userProfile: { name: '我' }, emojis: [], contextMsgs: [], fullMessages: [], initialData: {}, historyMsgCount: 0,
            xhsCaches: { xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(), commentAuthorNameCache: new Map(), commentParentIdCache: new Map() },
            api: { baseUrl: 'http://localhost:0', headers: {}, effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' } },
            directives: [{ type: 'chat_generate_image', prompt: '手部特写' }],
            hooks: { setMessages, addToast: vi.fn() },
        } as any);
        try {
            await started;
            const messages = await DB.getRecentMessagesByCharId(charId, 50);
            expect(messages.some(message => message.type === 'image' && message.content === 'image-ref')).toBe(true);
            expect(setMessages.mock.calls.some(([rows]) => rows.some((message: any) => message.type === 'image' && message.content === 'image-ref'))).toBe(true);
        } finally { release(); await run; }
    }, 10000);
});
