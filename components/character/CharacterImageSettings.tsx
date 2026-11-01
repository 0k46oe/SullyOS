import React from 'react';
import { useOS } from '../../context/OSContext';
import type { CharacterProfile } from '../../types';
import CharacterSettingsSection from './CharacterSettingsSection';
export default function CharacterImageSettings({ character, onChange }: { character: CharacterProfile; onChange: (patch: Partial<CharacterProfile>) => void }) {
    const { apiConfig, apiPresets } = useOS();
    const selection = character.imageGenerationSelection;
    return <>
        {character.tavernImport && <CharacterSettingsSection title="线上聊天动描" summary={character.chatActionDescriptionEnabled ? '已开启 · 每轮一段' : '默认关闭'}><label className="flex justify-between gap-3 text-sm">单独生成动作与神态描写<input type="checkbox" role="switch" checked={character.chatActionDescriptionEnabled === true} onChange={e => onChange({ chatActionDescriptionEnabled: e.target.checked })} /></label><p className="mt-2 text-xs text-slate-400">每轮一段，显示在时间戳下方。CSS 类名：sully-chat-action-description。</p></CharacterSettingsSection>}
        <CharacterSettingsSection title="生图提示词" summary={selection ? selection.provider.toUpperCase() + ' · ' + (apiConfig.imageGeneration?.presets?.[selection.provider]?.find(p => p.id === selection.presetId)?.name || (selection.presetId ? '原版本已删除' : '默认要求')) : '选择接口与版本'}>
            <p className="mb-3 text-xs text-slate-500">API Key 在设置填写；自动发图开关在聊天设置。以下选择随当前角色保存。</p>
            <select aria-label="角色生图提示词版本" className="w-full rounded-xl border p-3 text-sm" value={selection ? JSON.stringify([selection.provider, selection.presetId || '']) : ''} onChange={e => { const value = e.target.value ? JSON.parse(e.target.value) : null; onChange({ imageGenerationSelection: value ? { provider: value[0], presetId: value[1] || undefined } : undefined }); }}>
                <option value="">未选择</option>
                {selection?.presetId && !apiConfig.imageGeneration?.presets?.[selection.provider]?.some(p => p.id === selection.presetId) && <option value={JSON.stringify([selection.provider, selection.presetId])}>原版本已删除，请重新选择</option>}
                {(['oai', 'nai'] as const).map(provider => <optgroup key={provider} label={provider === 'oai' ? 'OAI' : 'NovelAI'}><option value={JSON.stringify([provider, ''])}>{provider.toUpperCase()} · 默认要求</option>{(apiConfig.imageGeneration?.presets?.[provider] || []).map(p => <option key={p.id} value={JSON.stringify([provider, p.id])}>{p.name}</option>)}</optgroup>)}
            </select>
            <label className="block mt-4 text-xs">整理生图提示词的文字 API<select aria-label="角色生图文字 API" className="mt-2 w-full rounded-xl border p-3 text-sm" value={character.imageTextApiPresetId || ""} onChange={e => onChange({imageTextApiPresetId: e.target.value || undefined})}><option value="">使用生图文字 API 默认配置</option>{character.imageTextApiPresetId && !apiPresets.some(p => p.id === character.imageTextApiPresetId) && <option value={character.imageTextApiPresetId}>原预设已删除，请重新选择</option>}{apiPresets.map(p => <option key={p.id} value={p.id}>{p.group ? p.group + " / " : ""}{p.name}</option>)}</select></label>
        </CharacterSettingsSection>
    </>;
}
