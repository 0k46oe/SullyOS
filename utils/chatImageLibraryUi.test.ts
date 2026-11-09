// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ChatModals from '../components/chat/ChatModals';

const mocks = vi.hoisted(() => {
    const records = Array.from({ length: 10 }, (_, i) => ({ id: `id-${i}`, imageRef: `image-${i}`, characterId: 'c', createdAt: i, provider: 'oai', prompt: '', requirement: '' }));
    return { records, list: vi.fn(async (_before?: string, limit = 12) => records.slice(0, limit)), remove: vi.fn(async (ids: string[]) => records.filter(item => ids.includes(item.id))), cleanup: vi.fn(async () => {}) };
});
vi.mock('../context/OSContext', () => ({ useOS: () => ({ updateCharacter: vi.fn() }) }));
vi.mock('../components/chat/EmojiDescriptionModal', () => ({ default: () => null }));
vi.mock('../utils/chatImageLibrary', () => ({ listGeneratedChatImages: mocks.list, removeGeneratedChatImages: mocks.remove, cleanupGeneratedChatImageBlobs: mocks.cleanup }));
vi.mock('../utils/blobRef', async importOriginal => ({ ...(await importOriginal<typeof import('../utils/blobRef')>()), useBlobRefUrl: () => undefined }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

it('selects all stored images, including images not yet displayed, and deletes them together', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const props: any = { modalType: 'generate-image', setModalType: vi.fn(), activeCharacter: { id: 'c', name: '角色' }, archivePrompts: [], apiPresets: [], allCharacters: [], messages: [], emojis: [], categories: [] };
    await act(async () => { root.render(React.createElement(ChatModals, props)); });
    const button = (text: string) => Array.from(container.querySelectorAll('button')).find(el => el.textContent === text)!;
    await act(async () => { button('多选').click(); });
    expect(container.querySelectorAll('input[aria-label="选择生图"]')).toHaveLength(8);
    await act(async () => { button('全选所有生图').click(); });
    expect(button('删除所选（10）')).toBeDefined();
    mocks.cleanup.mockImplementationOnce(() => new Promise<void>(() => {}));
    await act(async () => { button('删除所选（10）').click(); });
    expect(mocks.remove).toHaveBeenCalledWith(mocks.records.map(item => item.id));
    expect(mocks.cleanup).toHaveBeenCalledWith(mocks.records);
    expect(button('多选')).toBeDefined();
    await act(async () => { root.unmount(); });
});
