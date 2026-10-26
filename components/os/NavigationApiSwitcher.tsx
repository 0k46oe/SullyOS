import React, { useEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { AppID, type ApiPreset } from '../../types';
import { configFromPreset, findActivePresetId } from '../../utils/apiPresetSwitch';
import { describeDialogueApi, pickDialogueApi, resolveDialogueApi } from '../../utils/characterApi';
import { syncAmsgLlmCredentials } from '../../utils/amsgStateSync';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import ApiPresetGroups from '../settings/ApiPresetGroups';

export default function NavigationApiSwitcher({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  const { activeApp, activeCharacterId, characters, apiConfig, apiPresets, updateApiConfig, updateCharacter, addToast } = useOS();
  const character = activeApp === AppID.Chat ? characters.find(item => item.id === activeCharacterId) : undefined;
  const [scope, setScope] = useState<'character' | 'global'>(character ? 'character' : 'global');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previousFocus.current?.focus(); };
  }, []);
  useLocalBackHandler(() => { if (!busy) onClose(); return true; }, 60);
  const forCharacter = scope === 'character' && !!character;
  const current = forCharacter ? resolveDialogueApi(apiConfig, character) : apiConfig;
  const activeId = findActivePresetId(apiPresets, current);
  const filtered = apiPresets.filter(preset => [preset.name, preset.group, preset.config.model].some(value => value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const apply = async (preset?: ApiPreset) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (forCharacter) {
        await updateCharacter(character!.id, { dialogueApi: preset ? pickDialogueApi({ ...current, ...configFromPreset(preset) }) : undefined });
      } else if (preset) {
        const patch = configFromPreset(preset);
        updateApiConfig(patch);
        // Native Anthropic is local-only in this release; the Worker still speaks OpenAI.
        if (patch.protocol !== 'anthropic') syncAmsgLlmCredentials({ ...apiConfig, ...patch });
      }
      addToast(preset ? `已为${forCharacter ? character!.name : '全局'}切换到「${preset.name}」，下次发送生效` : '当前角色已恢复跟随全局 API', 'success');
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '切换失败，请重试'); setBusy(false);
    }
  };
  return <dialog ref={dialog} className="navigation-api-dialog" aria-labelledby="navigation-api-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="flex items-center justify-between gap-3">
      <h2 id="navigation-api-title" className="text-base font-semibold text-slate-700">快速切换 API</h2>
      <button type="button" autoFocus disabled={busy} aria-label="关闭 API 快切" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-500">关闭</button>
    </div>
    <label className="mt-4 block text-xs text-slate-500">切换范围
      <select aria-label="API 切换范围" disabled={busy} value={forCharacter ? 'character' : 'global'} onChange={event => setScope(event.target.value as 'character' | 'global')}
        className="mt-2 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
        {character && <option value="character">当前聊天角色 · {character.name}</option>}
        <option value="global">全局默认 API</option>
      </select>
    </label>
    <p className="mt-3 break-words text-xs text-slate-500">当前：{describeDialogueApi(current)} · {current.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}</p>
    <p className="mt-2 text-[11px] leading-relaxed text-slate-400">从下一次发送开始使用；正在生成的回复继续使用原接口。全局切换不会覆盖角色独立配置。</p>
    {apiPresets.some(preset => preset.config.protocol === 'anthropic') && <p className="mt-2 text-[11px] leading-relaxed text-slate-400">Anthropic 本次仅适配普通文字私聊，建议在当前聊天角色范围使用。</p>}
    {forCharacter && <button type="button" disabled={busy} onClick={() => { void apply(); }} className="mt-3 w-full rounded-xl bg-slate-100 px-3 py-3 text-left text-xs text-slate-600">{character!.dialogueApi ? '恢复跟随全局 API' : '当前角色正在跟随全局 API'}</button>}
    <input aria-label="搜索 API 预设" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索预设、分组或模型"
      className="my-4 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm" />
    <ApiPresetGroups presets={filtered}>{preset => <button key={preset.id} type="button" disabled={busy || !preset.config.baseUrl || !preset.config.model}
      aria-pressed={activeId === preset.id} onClick={() => { void apply(preset); }}
      className={`w-full rounded-xl border px-3 py-3 text-left disabled:opacity-50 ${activeId === preset.id ? 'border-primary bg-primary/5 text-primary' : 'border-slate-200 text-slate-600'}`}>
      <span className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{preset.name}</span><span className="shrink-0 text-[10px]">{activeId === preset.id ? '使用中' : '切换'}</span></span>
      <span className="mt-1 block truncate text-[11px] text-slate-400">{preset.config.model} · {preset.config.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}</span>
    </button>}</ApiPresetGroups>
    {!filtered.length && <p className="py-4 text-center text-xs text-slate-400">{apiPresets.length ? '没有匹配的预设' : '请先在 API 设置中保存预设'}</p>}
    {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
    <button type="button" disabled={busy} onClick={onOpenSettings} className="mt-4 w-full rounded-xl bg-slate-100 px-4 py-3 text-xs text-slate-600">打开完整 API 设置</button>
  </dialog>;
}
