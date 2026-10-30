// @vitest-environment jsdom
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatRecordsPanel from '../components/chat/ChatRecordsPanel';
import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { shareOrDownloadBlob } from './shareExport';
import { countChatWords, type WordFrequencyInput, type WordFrequencyOptions } from './chatWordFrequency';

vi.mock('./shareExport', () => ({ shareOrDownloadBlob: vi.fn(async () => 'downloaded') }));
vi.mock('./exportGuard', () => ({ confirmExportSafety: vi.fn(async () => true) }));

let container: HTMLDivElement;
let root: Root;
const char = { id: 'records-panel', name: '角色', contextLimit: 1 } as CharacterProfile;
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
const waitForUI = async (check: () => void) => {
    await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        check();
    });
};
const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob);
});

beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    localStorage.setItem(`mp_lastMsgId_${char.id}`, '2');
    await DB.deleteMessages([1, 2, 3, 4]);
    const rows: Message[] = [
        { id: 1, charId: char.id, role: 'user', type: 'text', content: '苹果 苹果', timestamp: 1 },
        { id: 2, charId: char.id, role: 'assistant', type: 'text', content: '香蕉 香蕉', timestamp: 2, metadata: { thinkingChain: '已保存思考' } },
        { id: 3, charId: char.id, role: 'user', type: 'text', content: '苹果', timestamp: 3 },
        { id: 4, charId: char.id, groupId: 'group', role: 'assistant', type: 'text', content: '群聊噪声', timestamp: 4 },
    ];
    for (const message of rows) await DB.saveMessage(message);
    vi.mocked(shareOrDownloadBlob).mockClear();
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('This local feature must not call an API'); }));
    await act(async () => { root.render(<ChatRecordsPanel character={char} userName="玩家" />); });
});

afterEach(() => {
    act(() => root.unmount()); container.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('chat records settings controls', () => {
    it('exports all persisted private history beyond the memory watermark, with an optional saved thought', async () => {
        await click(button('导出 JSON'));
        await waitForUI(() => expect(shareOrDownloadBlob).toHaveBeenCalledOnce());
        let options = vi.mocked(shareOrDownloadBlob).mock.calls[0][0];
        let data = JSON.parse((await readBlob(options.blob)).replace(/^\uFEFF/, ''));
        expect(data.messages.map((message: Message) => message.id)).toEqual([1, 2, 3]);
        expect(JSON.stringify(data)).not.toContain('已保存思考');
        const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        await click(toggle);
        await click(button('导出 JSON'));
        await waitForUI(() => expect(shareOrDownloadBlob).toHaveBeenCalledTimes(2));
        options = vi.mocked(shareOrDownloadBlob).mock.calls[1][0];
        data = JSON.parse((await readBlob(options.blob)).replace(/^\uFEFF/, ''));
        expect(data.messages[1].metadata.thinkingChain).toBe('已保存思考');
        expect(options.preferDownloadOnWeb).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('counts user and AI separately without network, including old archived text', async () => {
        expect(container.textContent).not.toContain('次计词');
        await click(button('统计高频词'));
        await waitForUI(() => expect(container.querySelectorAll('ol')).toHaveLength(2));
        expect(container.textContent).toContain('用户 · 玩家');
        expect(container.textContent).toContain('AI · 角色');
        const lists = container.querySelectorAll('ol');
        expect(lists[0].textContent).toContain('苹果3');
        expect(lists[1].textContent).toContain('香蕉2');
        expect(container.textContent).not.toContain('群聊噪声');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('runs the worker protocol and terminates it when leaving the panel', async () => {
        const terminate = vi.fn();
        const workerSpy = vi.fn();
        class TestWorker {
            onmessage?: (event: { data: unknown }) => void;
            onerror?: () => void;
            terminate = terminate;
            constructor(url: URL, options: WorkerOptions) { workerSpy(url, options); }
            postMessage(data: { inputs: WordFrequencyInput[]; options: WordFrequencyOptions }) {
                this.onmessage?.({ data: { result: countChatWords(data.inputs, data.options) } });
            }
        }
        vi.stubGlobal('Worker', TestWorker);
        await click(button('统计高频词'));
        await waitForUI(() => expect(workerSpy).toHaveBeenCalledOnce());
        expect(workerSpy).toHaveBeenCalledOnce();
        expect(workerSpy.mock.calls[0][0].pathname).toContain('chatWordFrequency.worker.ts');
        expect(container.textContent).toContain('苹果3');
        expect(terminate).toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reports a failed export and re-enables the buttons', async () => {
        vi.mocked(shareOrDownloadBlob).mockRejectedValueOnce(new Error('无法保存'));
        await click(button('导出 TXT'));
        await waitForUI(() => expect(container.textContent).toContain('导出失败：无法保存'));
        expect(container.textContent).toContain('导出失败：无法保存');
        expect(button('导出 TXT').disabled).toBe(false);
    });
});
