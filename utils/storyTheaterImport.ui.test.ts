// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, StoryTheaterEntry, UserProfile } from '../types';
import StoryTheaterEditor from '../components/date/story/StoryTheaterEditor';
import { BUILTIN_NIGHT_SCREENING_PRESET, createStoryTheaterDraft, parseStoryTheaterPreset } from './storyTheater';

vi.mock('../components/os/TokenImg', () => ({ default: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); });

const actor = { id: 'rain', name: '小雨', tavernImport: { firstMessage: '{{char}}站在门口。', alternateGreetings: ['{{user}}推开了门。'] } } as CharacterProfile;
const initial = (): StoryTheaterEntry => ({ ...createStoryTheaterDraft(), title: '雨夜' });
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text) as HTMLButtonElement;
async function render(entry = initial(), extra: Partial<React.ComponentProps<typeof StoryTheaterEditor>> = {}) {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    const onSave = vi.fn();
    await act(async () => root!.render(React.createElement(StoryTheaterEditor, {
        initial: entry, characters: [actor], user: { name: '本人' } as UserProfile,
        masks: [], maskLocked: false, presets: [BUILTIN_NIGHT_SCREENING_PRESET],
        onCancel: () => {}, onSave, onImportPreset: async () => null,
        onEditPreset: () => {}, onOpenMaskBox: () => {}, ...extra,
    })));
    return onSave;
}
async function click(text: string) { await act(async () => button(text).click()); }

describe('剧情酒馆导入界面', () => {
    it('无角色时不能保存；选演员及备选开场白后把原文快照交给保存流程', async () => {
        const onSave = await render();
        await click('酒馆开场白');
        expect(button('保存并进入').disabled).toBe(true);
        expect(host.textContent).toContain('卡内包含开场白');
        await click('小雨');
        const select = host.querySelector('[aria-label="酒馆开场白"]') as HTMLSelectElement;
        expect(select.options).toHaveLength(3);
        await act(async () => { select.value = JSON.stringify(['rain', 1]); select.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(host.textContent).toContain('{{user}}推开了门。');
        expect(button('保存并进入').disabled).toBe(false);
        await click('保存并进入');
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ openingMode: 'card', cardOpening: expect.objectContaining({ greetingIndex: 1, content: '{{user}}推开了门。' }) }));
    });

    it('真实时间陪伴不能使用酒馆开场白；开始后的选择被锁定', async () => {
        await render({ ...initial(), characterIds: [actor.id], writesToCharacterMemory: true });
        expect(button('酒馆开场白').disabled).toBe(true);
        await click('虚构剧场');
        await click('酒馆开场白');
        expect((host.querySelector('[aria-label="酒馆开场白"]') as HTMLSelectElement).value).toBe(JSON.stringify(['rain', 0]));
        await click('真实时间陪伴');
        expect(host.querySelector('[aria-label="酒馆开场白"]')).toBeNull();
        expect(button('酒馆开场白').disabled).toBe(true);
    });

    it('上传 JSON 后选择新预设并展示持久的兼容说明', async () => {
        const imported = parseStoryTheaterPreset(JSON.stringify({ prompts: [{ identifier: 'main', content: '正文' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }] }), '酒馆预设.json');
        const onImport = vi.fn(async () => imported);
        await render({ ...initial(), characterIds: [actor.id] }, { presets: [BUILTIN_NIGHT_SCREENING_PRESET, imported], onImportPreset: onImport });
        const input = host.querySelector('input[type=file]') as HTMLInputElement;
        const file = new File(['{}'], '酒馆预设.json', { type: 'application/json' });
        Object.defineProperty(input, 'files', { value: [file] });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
        expect(onImport).toHaveBeenCalledWith(file);
        expect(host.querySelectorAll('details')).toHaveLength(1);
        expect(host.textContent).toContain('酒馆预设兼容说明');
        expect(host.textContent).toContain('不执行或模拟');
        expect([...host.querySelectorAll('select')].some(select => select.value === imported.id)).toBe(true);
    });
});
