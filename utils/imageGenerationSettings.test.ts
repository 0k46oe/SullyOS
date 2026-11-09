// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImageGenerationSettings from '../components/settings/ImageGenerationSettings';
import type { ImageGenerationConfig } from '../types';

vi.mock('../context/OSContext', () => ({ useOS: () => ({ apiPresets: [] }) }));

describe('OAI image model picker', () => {
    afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

    it('opens fetched models, selects one, and keeps manual input and cancellation', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'image-a' }, { id: 'image-b' }] }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        function Form() {
            const [value, setValue] = useState<ImageGenerationConfig>({ oai: { baseUrl: 'https://example.com/v1', apiKey: 'key', model: 'manual-model' } });
            return React.createElement(ImageGenerationSettings, { value, onChange: setValue });
        }
        const button = (label: string) => Array.from(container.querySelectorAll('button')).find(el => el.textContent === label)!;
        await act(async () => { root.render(React.createElement(Form)); });
        await act(async () => { button('拉取模型').click(); });
        expect(fetchMock).toHaveBeenCalledWith('https://example.com/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer key' } }));
        expect(container.querySelector('[role="dialog"]')?.textContent).toContain('image-b');
        await act(async () => { button('image-b').click(); });
        const input = container.querySelector<HTMLInputElement>('input[aria-label="oai model"]')!;
        expect(input.value).toBe('image-b');
        await act(async () => { button('选择已拉取的模型').click(); });
        await act(async () => { button('关闭').click(); });
        expect(input.value).toBe('image-b');
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'custom-model');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(input.value).toBe('custom-model');
        await act(async () => { root.unmount(); });
    });
});
