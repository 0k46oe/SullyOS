import React from 'react';
import { useOS } from '../../context/OSContext';
import type { CharacterProfile } from '../../types';
import CharacterSettingsSection from './CharacterSettingsSection';
export default function CharacterImageSettings({ character, onChange }: { character: CharacterProfile; onChange: (patch: Partial<CharacterProfile>) => void }) {
    const { apiConfig, apiPresets } = useOS();
    const selection = character.imageGenerationSelection;
    return <>
        {character.tavernImport && <CharacterSettingsSection title="线上聊天动描" summary={character.chatActionDescriptionEnabled ? '已开启 · 每轮一段' : '默认关闭'}>
            <label className="flex min-w-0 items-start justify-between gap-3 text-sm text-slate-700">
                <span className="min-w-0 flex-1 break-words leading-6">单独生成动作与神态描写</span>
                <input className="mt-1 shrink-0" type="checkbox" role="switch" checked={character.chatActionDescriptionEnabled === true} onChange={e => onChange({ chatActionDescriptionEnabled: e.target.checked })} />
            </label>
            <p className="mt-2 break-words text-xs leading-relaxed text-slate-400">每轮一段，显示在时间戳下方。CSS 类名：sully-chat-action-description。</p>
        </CharacterSettingsSection>}
        <CharacterSettingsSection title="生图提示词" summary={selection ? selection.provider.toUpperCase() + ' · ' + (apiConfig.imageGeneration?.presets?.[selection.provider]?.find(p => p.id === selection.presetId)?.name || (selection.presetId ? '原版本已删除' : '默认要求')) : '选择接口与版本'}>
            <p className="mb-3 break-words text-xs leading-relaxed text-slate-500">API Key 在设置填写；自动发图开关在聊天设置。以下选择随当前角色保存。</p>
            <label className="block min-w-0 text-xs text-slate-600">
                <span className="block break-words leading-5">选择接口与提示词版本</span>
                <select aria-label="角色生图提示词版本" className="mt-2 block w-full min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-sm" value={selection ? JSON.stringify([selection.provider, selection.presetId || '']) : ''} onChange={e => { const value = e.target.value ? JSON.parse(e.target.value) : null; onChange({ imageGenerationSelection: value ? { provider: value[0], presetId: value[1] || undefined, faceRouting: value[0] === 'oai' && selection?.provider === 'oai' ? selection.faceRouting : undefined } : undefined }); }}>
                <option value="">未选择</option>
                {selection?.presetId && !apiConfig.imageGeneration?.presets?.[selection.provider]?.some(p => p.id === selection.presetId) && <option value={JSON.stringify([selection.provider, selection.presetId])}>原版本已删除，请重新选择</option>}
                {(['oai', 'nai'] as const).map(provider => <optgroup key={provider} label={provider === 'oai' ? 'OAI' : 'NovelAI'}><option value={JSON.stringify([provider, ''])}>{provider.toUpperCase()} · 默认要求</option>{(apiConfig.imageGeneration?.presets?.[provider] || []).map(p => <option key={p.id} value={JSON.stringify([provider, p.id])}>{p.name}</option>)}</optgroup>)}
                </select>
            </label>
            {selection?.provider === 'oai' && <div className="mt-4 space-y-3 text-xs text-slate-600">
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!selection.faceRouting} onChange={e => onChange({ imageGenerationSelection: { ...selection, faceRouting: e.target.checked ? {} : undefined } })} />自动发图按是否露脸选择预设</label>
                {selection.faceRouting && <>
                    <p className="leading-relaxed text-slate-400">角色自动发图时使用这两套预设；无法识别时会请你选择。请先在设置中创建预设。</p>
                    {([['facePresetId', '露脸预设 A'], ['noFacePresetId', '不露脸预设 B']] as const).map(([key, label]) => <label key={key} className="block">{label}<select aria-label={label} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white p-3" value={selection.faceRouting?.[key] || ''} onChange={e => onChange({ imageGenerationSelection: { ...selection, faceRouting: { ...selection.faceRouting, [key]: e.target.value || undefined } } })}>
                        <option value="">请选择预设</option>
                        {selection.faceRouting?.[key] && !apiConfig.imageGeneration?.presets?.oai?.some(p => p.id === selection.faceRouting?.[key]) && <option value={selection.faceRouting[key]}>原预设已删除，请重新选择</option>}
                        {(apiConfig.imageGeneration?.presets?.oai || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select></label>)}
                </>}
            </div>}
            <label className="mt-4 block min-w-0 text-xs text-slate-600"><span className="block break-words leading-5">整理生图提示词的文字 API</span><select aria-label="角色生图文字 API" className="mt-2 block w-full min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-sm" value={character.imageTextApiPresetId || ""} onChange={e => onChange({imageTextApiPresetId: e.target.value || undefined})}><option value="">使用生图文字 API 默认配置</option>{character.imageTextApiPresetId && !apiPresets.some(p => p.id === character.imageTextApiPresetId) && <option value={character.imageTextApiPresetId}>原预设已删除，请重新选择</option>}{apiPresets.map(p => <option key={p.id} value={p.id}>{p.group ? p.group + " / " : ""}{p.name}</option>)}</select></label>
        </CharacterSettingsSection>
    </>;
}
