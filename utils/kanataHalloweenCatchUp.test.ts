// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HalloweenActions, HalloweenCatchUpCompletion, HalloweenCatchUpSettings, HalloweenChibi, HalloweenDialogue, HalloweenPumpkins, KanataHalloweenProvider } from '../apps/vrWorld/KanataHalloween';
import { endHalloweenCatchUp, finishHalloweenDialogue, startHalloweenCatchUp } from './vrWorld/kanataHalloween';
import { createFishingMarketState, FISHING_MARKET_STORAGE_KEY, readFishingMarketState, saveFishingMarketState } from './vrWorld/fishingMarket';

let root: Root, host: HTMLDivElement;
const at = new Date(2026, 10, 3, 12).getTime();
function Session({ npcEnabled = true }: { npcEnabled?: boolean }) {
    const [npc, setNpc] = useState(false);
    return React.createElement(KanataHalloweenProvider, null,
        React.createElement(HalloweenCatchUpSettings, { npcEnabled }),
        React.createElement(HalloweenPumpkins),
        React.createElement(HalloweenChibi, { actorId: 'char', img: '/original.png', name: '角色' }),
        React.createElement(HalloweenActions, { actorId: 'char', name: '角色' }),
        npcEnabled && React.createElement('button', { onClick: () => setNpc(true) }, '体验艾文剧情'),
        npc && React.createElement(HalloweenDialogue, { npc: 'aiven', userName: '我', onClose: () => setNpc(false) }),
        !npc && npcEnabled && React.createElement(HalloweenCatchUpCompletion));
}
const render = (npcEnabled = true) => act(async () => root.render(React.createElement(Session, { npcEnabled })));
const click = (label: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label);
    expect(button, label).toBeTruthy();
    button!.click();
});
const completion = () => document.querySelector('dialog[aria-labelledby="halloween-catch-up-title"]');
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers(); vi.setSystemTime(at); localStorage.clear();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove(); vi.restoreAllMocks(); vi.useRealTimers();
});

it('restores costumes, pumpkins and candy after explicit opt-in, then removes them while keeping collectibles', async () => {
    await render();
    expect(host.querySelector('.kanata-pumpkins')).toBeNull();
    expect(host.querySelector('.kanata-halloween-actions')).toBeNull();
    await click('开启补体验');
    expect(host.querySelector('.kanata-pumpkins')).toBeTruthy();
    expect(host.querySelector('.kanata-halloween-costume')).toBeTruthy();
    await click('不给糖就捣蛋！！');
    expect(Object.values(readFishingMarketState().kanataHalloween!.candies)).toEqual([1]);
    await click('结束活动');
    expect(host.querySelector('.kanata-pumpkins')).toBeNull();
    expect(host.querySelector('.kanata-halloween-costume')).toBeNull();
    expect(host.querySelector('.kanata-halloween-actions')).toBeNull();
    expect(Object.values(readFishingMarketState().kanataHalloween!.candies)).toEqual([1]);
    expect(readFishingMarketState().kanataHalloween!.collectedCostumes).toHaveLength(1);
});

it('shows the completion choice only after the last reward is collected, and remembers continuing across remounts', async () => {
    saveFishingMarketState(finishHalloweenDialogue(startHalloweenCatchUp(createFishingMarketState(1)), 'caian', '我', false, at));
    await render();
    expect(completion()).toBeNull();
    await click('体验艾文剧情');
    await click('继续对话');
    await click('不给糖就捣蛋！');
    await click('继续对话');
    expect(document.body.textContent).toContain('收到万圣小恐龙！');
    expect(completion()).toBeNull();
    await click('收好');
    expect(completion()?.hasAttribute('open')).toBe(true);
    await click('继续收集');
    expect(completion()).toBeNull();
    expect(readFishingMarketState().kanataHalloween?.catchUp).toBe('collecting');
    await act(async () => root.render(null)); await render();
    expect(completion()).toBeNull();
    expect(host.querySelector('.kanata-pumpkins')).toBeTruthy();
    await click('结束活动');
    expect(readFishingMarketState().inventory.filter(item => item.speciesId === 'halloween-dinosaur')).toHaveLength(1);
    expect(readFishingMarketState().kanataHalloween?.completed).toEqual(['caian', 'aiven']);
});

it('can end from the completion dialog and cannot award gifts again when reopened', async () => {
    let state = startHalloweenCatchUp(createFishingMarketState(1));
    state = finishHalloweenDialogue(finishHalloweenDialogue(state, 'caian', '我', false, at), 'aiven', '我', false, at);
    saveFishingMarketState(state);
    await render();
    expect(completion()).toBeTruthy();
    const button = [...completion()!.querySelectorAll('button')].find(item => item.textContent === '结束活动')!;
    await act(async () => button.click());
    expect(completion()).toBeNull();
    expect(host.querySelector('.kanata-pumpkins')).toBeNull();
    await click('开启补体验');
    await click('继续收集');
    await click('体验艾文剧情'); await click('继续对话'); await click('不给糖就捣蛋！'); await click('继续对话');
    expect(document.body.textContent).toContain('这份心意已经收好啦。');
    expect(readFishingMarketState().inventory).toHaveLength(1);
    expect(readFishingMarketState().kanataHalloween?.candies).toEqual(state.kanataHalloween?.candies);
});

it('keeps the previous save and offers retry when ending cannot be saved', async () => {
    saveFishingMarketState(startHalloweenCatchUp(createFishingMarketState(1)));
    await render();
    const raw = localStorage.getItem(FISHING_MARKET_STORAGE_KEY);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('存储已满'); });
    await click('结束活动');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('存储已满');
    expect(localStorage.getItem(FISHING_MARKET_STORAGE_KEY)).toBe(raw);
    expect(host.querySelector('.kanata-pumpkins')).toBeTruthy();
});

it('responds to another tab ending the event and respects hiding NPC content', async () => {
    let state = startHalloweenCatchUp(createFishingMarketState(1));
    state = finishHalloweenDialogue(finishHalloweenDialogue(state, 'caian', '我', false, at), 'aiven', '我', false, at);
    saveFishingMarketState(state);
    await render(false);
    expect(completion()).toBeNull();
    expect(host.textContent).toContain('需先开启「常驻 NPC」');
    await act(async () => {
        localStorage.setItem(FISHING_MARKET_STORAGE_KEY, JSON.stringify(endHalloweenCatchUp(state)));
        window.dispatchEvent(new StorageEvent('storage', { key: FISHING_MARKET_STORAGE_KEY }));
    });
    expect(host.querySelector('.kanata-pumpkins')).toBeNull();
    expect(host.querySelector('.kanata-halloween-actions')).toBeNull();
});
