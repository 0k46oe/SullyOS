import React, { useEffect, useState } from 'react';
import type { CharacterProfile, TavernStoryTimeConfig } from '../../types';
import CharacterSettingsSection from './CharacterSettingsSection';
import {
    appendStorySegment,
    currentStoryDraft,
    formatStoryDateTime,
    getActiveTavernStoryTime,
    validateStoryDraft,
    type StoryTimeDraft,
} from '../../utils/tavernStoryTime';

/** 酒馆导入角色专属：剧情时间设置。普通角色不渲染。 */
export default function TavernStoryTimeSettings({ character, onChange }: {
    character: CharacterProfile;
    onChange: (value: TavernStoryTimeConfig) => void;
}) {
    const config = character.tavernStoryTime;
    const [draft, setDraft] = useState<StoryTimeDraft>(() => currentStoryDraft(config));
    const [saved, setSaved] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    // 换角色时重新读取草稿
    useEffect(() => { setDraft(currentStoryDraft(character.tavernStoryTime)); setSaved(false); }, [character.id]);
    // 当前剧情时间每 30 秒刷新一次显示
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, []);

    if (!character.tavernImport) return null;

    const active = getActiveTavernStoryTime(character);
    const error = validateStoryDraft(draft);
    const summary = active ? formatStoryDateTime(active, now) : config?.enabled ? '待填写' : '未开启';
    const update = (patch: Partial<StoryTimeDraft>) => { setDraft(prev => ({ ...prev, ...patch })); setSaved(false); };

    const toggle = () => {
        const enabled = !config?.enabled;
        // 第一次开启且还没保存过时间：用当前草稿建第一段，避免开了却没生效
        if (enabled && !config?.segments?.length) {
            const next = appendStorySegment({ enabled: true, segments: [] }, draft);
            if (next) { onChange(next); return; }
        }
        onChange({ enabled, segments: config?.segments || [] });
    };

    const save = () => {
        const next = appendStorySegment({ enabled: true, segments: config?.segments || [] }, draft);
        if (!next) return;
        onChange(next);
        setSaved(true);
    };

    return <CharacterSettingsSection title="剧情时间" summary={summary}>
        <div className="rounded-3xl bg-white p-4 shadow-sm space-y-4">
            <label className="flex items-center justify-between gap-3 text-sm text-slate-600">
                为这个角色使用剧情时间
                <input type="checkbox" checked={config?.enabled === true} onChange={toggle} />
            </label>
            <p className="text-xs text-slate-400 leading-relaxed">只影响这个酒馆角色。开启后记忆宫殿记录和召回记忆时使用剧情日期，不再出现现实年份。剧情时间跟着现实一起走：现实过 30 分钟，剧情也过 30 分钟。</p>

            {config?.enabled && <>
                {active && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">现在的剧情时间：<span className="font-bold">{formatStoryDateTime(active, now)}</span></p>}

                <div className="flex gap-2 text-xs">
                    {([['calendar', '标准日期'], ['label', '自定义纪年']] as const).map(([mode, label]) => (
                        <button key={mode} type="button" onClick={() => update({ mode })}
                            className={`flex-1 rounded-xl border p-2 ${draft.mode === mode ? 'border-primary bg-primary/10 text-primary font-bold' : 'border-slate-200 text-slate-500'}`}>
                            {label}
                        </button>
                    ))}
                </div>

                {draft.mode === 'calendar'
                    ? <label className="block text-xs text-slate-500">剧情日期
                        <input aria-label="剧情日期" className="mt-2 w-full rounded-xl border border-slate-200 p-3 text-sm" value={draft.storyDate} placeholder="3777-11-01" onChange={event => update({ storyDate: event.target.value })} />
                        <span className="mt-1 block text-[11px] text-slate-400">年-月-日，年份可以随便写，例如 3777。日期会自动往后推。</span>
                    </label>
                    : <label className="block text-xs text-slate-500">纪年文字
                        <input aria-label="纪年文字" className="mt-2 w-full rounded-xl border border-slate-200 p-3 text-sm" value={draft.label} placeholder="庚辰年 / 星历 2077 季" onChange={event => update({ label: event.target.value })} />
                        <span className="mt-1 block text-[11px] text-slate-400">这种写法没法自动算下一天，文字会一直保持你填的样子，只有时分会走。要换日子就回来改。</span>
                    </label>}

                <label className="block text-xs text-slate-500">剧情时刻
                    <input aria-label="剧情时刻" className="mt-2 w-full rounded-xl border border-slate-200 p-3 text-sm" value={draft.storyClock} placeholder="14:20" onChange={event => update({ storyClock: event.target.value })} />
                </label>

                {error && <p className="text-xs text-rose-500">{error}</p>}
                <button type="button" disabled={!!error} onClick={save}
                    className="w-full rounded-xl bg-primary p-3 text-sm font-bold text-white disabled:opacity-40">
                    {saved ? '已保存' : '保存为现在的剧情时间'}
                </button>
                <p className="text-[11px] text-slate-400 leading-relaxed">剧情跳到第二天时，把日期改了再保存就行。改之前已经发生的聊天和记忆，日期保持不变。</p>
            </>}
        </div>
    </CharacterSettingsSection>;
}
