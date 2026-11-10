// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import GeneratedImagePair from '../components/chat/GeneratedImagePair';

vi.mock('./chatImageTextCard', () => ({ createImageTextCard: () => ({ toDataURL: () => 'data:image/png;base64,VEVYVA==' }) }));
vi.mock('../components/os/TokenImg', () => ({ default: (props: any) => React.createElement('img', { alt: props.alt, src: props.value }) }));
vi.mock('../components/chat/ChatImage', () => ({ ImageViewer: () => React.createElement('div', { role: 'dialog' }, '大图') }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('generated image pair', () => {
    it('flips the stack and expands two cards on both sides', () => {
        const host = document.createElement('div'); document.body.append(host);
        const root = createRoot(host);
        act(() => root.render(React.createElement(GeneratedImagePair, { value: 'image.png', prompt: '画面', isUser: false, selectionMode: false })));
        expect(host.querySelector('.sully-chat-generated-pair.is-ai')).toBeTruthy();
        expect(host.querySelectorAll('.sully-chat-generated-stack .sully-chat-generated-face')).toHaveLength(2);
        const stack = host.querySelector<HTMLButtonElement>('.sully-chat-generated-stack')!;
        expect(stack.getAttribute('aria-label')).toBe('切换到文字描述图');
        act(() => stack.click());
        expect(stack.getAttribute('aria-label')).toBe('切换到生成图片');
        act(() => host.querySelector<HTMLButtonElement>('.sully-chat-image-expand')!.click());
        expect(host.querySelectorAll('.sully-chat-generated-card')).toHaveLength(2);
        expect(host.querySelector('.sully-chat-image-expand')?.textContent).toBe('收起');
        act(() => root.render(React.createElement(GeneratedImagePair, { value: 'image.png', prompt: '画面', isUser: true, selectionMode: false })));
        expect(host.querySelector('.sully-chat-generated-pair.is-user')).toBeTruthy();
        act(() => root.unmount()); host.remove();
    });
});
