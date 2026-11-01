import React, { useEffect, useState } from 'react';
import type { CharacterProfile, TavernStoryTimeConfig } from '../../types';
import CharacterSettingsSection from './CharacterSettingsSection';
import {
    buildTavernStoryTimeConfig,
    currentYearLabel,
    formatStoryDateTime,
    getActiveTavernStoryTime,
    normalizeTavernStoryTime,
} from '../../utils/tavernStoryTime';

/** 酒馆导入角色专属：剧情年份设置。普通角色不渲染。 */
export default function TavernStoryTimeSettings({ character, onChange }: {
    character: CharacterProfile;
    onChange: (value: TavernStoryTimeConfig) => void;
}) {
    const enabled = normalizeTavernStoryTime(character.tavernStoryTime)?.enabled === true;
    const [draft, setDraft] = useState(() => currentYearLabel(character));
    const [now, setNow] = useState(() => Date.now());

    // 换角色时重新读取
    useEffect(() => { setDraft(currentYearLabel(character)); }, [character.id]);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, []);

    if (!character.tavernImport) return null;

    const active = getActiveTavernStoryTime(character);
    const saved = currentYearLabel(character, now);
    const dirty = draft.trim() !== saved;
    const summary = active ? formatStoryDateTime(active, now) : enabled ? '请填写年份' : '未开启';

    const toggle = () => onChange(buildTavernStoryTimeConfig(character, { enabled: !enabled, yearLabel: draft.trim() || saved }));
    const save = () => onChange(buildTavernStoryTimeConfig(character, { enabled: true, yearLabel: draft.trim() }));

    return <CharacterSettingsSection title="剧情年份" summary={summary}>
        <div className="rounded-3xl bg-white p-4 shadow-sm space-y-4">
            <label className="flex items-center justify-between gap-3 text-sm text-slate-600">
                为这个角色使用剧情年份
                <input type="checkbox" checked={enabled} onChange={toggle} />
            </label>
            <p className="text-xs text-slate-400 leading-relaxed">只影响这个酒馆角色。开启后，线上聊天、见面、查手机和记忆宫殿里，角色看到的年份换成你填的年份，月、日、时、分和现实一样；天气、新闻、现实节日和纪念日不再告诉角色。</p>

            {enabled && <>
                <label className="block text-xs text-slate-500">现在的剧情年份
                    <input aria-label="剧情年份" className="mt-2 w-full rounded-xl border border-slate-200 p-3 text-sm" value={draft}
                        placeholder="3777年 / 庚辰年 / 天启三年 / 星历2077年" onChange={event => setDraft(event.target.value)} />
                    <span className="mt-1 block text-[11px] text-slate-400 leading-relaxed">现实每跨一年，这里自动往后推一年：3777年→3778年，庚辰年→辛巳年，天启三年→天启四年。没有数字的写法（比如「太初纪元」）会一直保持原样。</span>
                </label>
                {active && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">角色现在看到的时间：<span className="font-bold">{formatStoryDateTime(active, now)}</span></p>}
                <button type="button" disabled={!draft.trim() || !dirty} onClick={save}
                    className="w-full rounded-xl bg-primary p-3 text-sm font-bold text-white disabled:opacity-40">
                    {dirty ? '保存年份' : '已保存'}
                </button>
            </>}
        </div>
    </CharacterSettingsSection>;
}
