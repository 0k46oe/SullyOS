// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageViewer } from '../components/chat/ChatImage';

vi.mock('./blobRef', () => ({ useBlobRefUrl: (value?: string) => value || '' }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { document.body.innerHTML = ''; });

describe('ImageViewer gallery navigation', () => {
    it('swipes between images and keeps the viewer open', () => {
        const host = document.createElement('div'); document.body.append(host);
        const root = createRoot(host);
        function Harness() {
            const [index, setIndex] = useState(0);
            const images = ['first.png', 'second.png', 'third.png'];
            return React.createElement(ImageViewer, { value: images[index], fallback: images[index], items: images, index, onIndexChange: setIndex, onClose: () => {} });
        }
        act(() => root.render(React.createElement(Harness)));
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        const stage = dialog.querySelector<HTMLElement>('.chat-image-stage')!;
        const swipe = (fromX: number, toX: number) => {
            const start = new Event('touchstart', { bubbles: true });
            Object.defineProperty(start, 'touches', { value: [{ clientX: fromX, clientY: 100 }] });
            const end = new Event('touchend', { bubbles: true });
            Object.defineProperty(end, 'changedTouches', { value: [{ clientX: toX, clientY: 104 }] });
            act(() => { stage.dispatchEvent(start); stage.dispatchEvent(end); });
        };

        expect(dialog.querySelector('.chat-image-viewer-count')?.textContent).toBe('1 / 3');
        swipe(240, 100);
        expect(dialog.querySelector('.chat-image-viewer-count')?.textContent).toBe('2 / 3');
        expect(dialog.querySelector('img')?.getAttribute('src')).toBe('second.png');
        swipe(100, 240);
        expect(dialog.querySelector('.chat-image-viewer-count')?.textContent).toBe('1 / 3');
        expect(document.querySelector('[role="dialog"]')).toBeTruthy();

        act(() => root.unmount());
        host.remove();
    });
});
