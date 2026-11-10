// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import GeneratedImageSaveStatus from '../components/chat/GeneratedImageSaveStatus';
const save = vi.hoisted(() => vi.fn());
vi.mock('./chatImageLibrary', () => ({ savePendingAutomaticImage: save }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
describe('generated image save status', () => {
    it('offers retry after a save error and shows success after retry', async () => {
        save.mockRejectedValueOnce(new Error('storage error')).mockResolvedValueOnce('saved');
        const host = document.createElement('div'); document.body.append(host);
        const root = createRoot(host);
        await act(async () => { root.render(React.createElement(GeneratedImageSaveStatus, { messageId: 42 })); });
        expect(host.textContent).toContain('保存失败，点击重试');
        await act(async () => { host.querySelector('button')!.click(); });
        expect(host.textContent).toContain('已保存到图库');
        expect(save).toHaveBeenCalledTimes(2);
        act(() => root.unmount()); host.remove();
    });
});
