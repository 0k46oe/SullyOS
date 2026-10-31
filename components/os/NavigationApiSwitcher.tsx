import { llmApiType } from '../../utils/llmEndpoint';
import React, { useEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { AppID, type ApiPreset } from '../../types';
import { configFromPreset, findActivePresetId } from '../../utils/apiPresetSwitch';
import { describeDialogueApi, pickDialogueApi, resolveDialogueApi } from '../../utils/characterApi';
import { syncAmsgLlmCredentials } from '../../utils/amsgStateSync';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { ArrowRight, ArrowUUpLeft, Check, GlobeHemisphereWest, MagnifyingGlass, PlugsConnected, SlidersHorizontal, UserCircle, X } from '@phosphor-icons/react';

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
  const groups = new Map<string, ApiPreset[]>();
  for (const preset of filtered) {
    const name = preset.group?.trim() || '未分组';
    groups.set(name, [...(groups.get(name) || []), preset]);
  }
  const apply = async (preset?: ApiPreset) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (forCharacter) {
        await updateCharacter(character!.id, { dialogueApi: preset ? pickDialogueApi({ ...current, ...configFromPreset(preset) }) : undefined });
      } else if (preset) {
        const patch = configFromPreset(preset);
        updateApiConfig(patch);
        // Credential sync performs the upstream native-Worker capability check.
        syncAmsgLlmCredentials({ ...apiConfig, ...patch });
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
    <header className="navigation-api-header">
      <span className="navigation-api-heading-icon" aria-hidden="true"><PlugsConnected size={23} weight="duotone" /></span>
      <div><h2 id="navigation-api-title">快速切换 API</h2><p>选好预设，下次发送即生效</p></div>
      <button type="button" autoFocus disabled={busy} aria-label="关闭 API 快切" onClick={onClose} className="navigation-api-close"><X size={18} /></button>
    </header>
    <div className="navigation-api-body">
      <div role="group" aria-label="API 切换范围" className="navigation-api-scope">
        {character && <button type="button" disabled={busy} aria-pressed={forCharacter} onClick={() => setScope('character')}><UserCircle size={17} />当前角色</button>}
        <button type="button" disabled={busy} aria-pressed={!forCharacter} onClick={() => setScope('global')}><GlobeHemisphereWest size={17} />全局默认</button>
      </div>
      <section className="navigation-api-current" aria-label="当前 API 配置">
        <div className="navigation-api-current-label"><span className="navigation-api-status-dot" /><span>{forCharacter ? character!.name : '全局默认 API'}</span><span className="navigation-api-protocol">{llmApiType(current) === 'anthropic' ? 'Anthropic' : 'OpenAI'}</span></div>
        <p className="navigation-api-current-name">{apiPresets.find(preset => preset.id === activeId)?.name || '当前配置'}</p>
        <p className="navigation-api-current-detail" title={describeDialogueApi(current)}>{describeDialogueApi(current)}</p>
        {forCharacter && (character!.dialogueApi
          ? <button type="button" disabled={busy} onClick={() => { void apply(); }} className="navigation-api-follow"><ArrowUUpLeft size={13} />恢复跟随全局 API</button>
          : <span className="navigation-api-following">正在跟随全局 API</span>)}
      </section>
      <label className="navigation-api-search"><MagnifyingGlass size={17} aria-hidden="true" /><input aria-label="搜索 API 预设" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索预设、分组或模型" /></label>
      <div className="navigation-api-presets" aria-busy={busy}>
        {[...groups].map(([name, presets]) => <section key={name} className="navigation-api-group" aria-label={`${name}预设`}>
          <h3>{name}<span>{presets.length}</span></h3>
          <div className="navigation-api-grid">{presets.map(preset => {
            const active = activeId === preset.id;
            const native = llmApiType(preset.config) === 'anthropic';
            return <button key={preset.id} type="button" disabled={busy || !preset.config.baseUrl?.trim() || !preset.config.model?.trim()}
              aria-pressed={active} onClick={() => { void apply(preset); }} className="navigation-api-preset" title={`${preset.name} · ${preset.config.model}`}>
              <span className="navigation-api-preset-top"><span className="navigation-api-avatar" data-protocol={native ? 'anthropic' : 'openai'} aria-hidden="true">{native ? 'A' : 'O'}</span><span className="navigation-api-selection">{active ? <><Check size={12} weight="bold" />使用中</> : <ArrowRight size={15} aria-hidden="true" />}</span></span>
              <span className="navigation-api-preset-name">{preset.name}</span>
              <span className="navigation-api-model">{preset.config.model || '未填写模型'}</span>
              <span className="navigation-api-preset-protocol">{native ? 'Anthropic' : 'OpenAI 兼容'}</span>
            </button>;
          })}</div>
        </section>)}
        {!filtered.length && <p className="navigation-api-empty">{apiPresets.length ? '没有匹配的预设，试试其他关键词' : '请先在 API 设置中保存预设'}</p>}
      </div>
      {error && <p role="alert" className="navigation-api-error">{error}</p>}
      <p className="navigation-api-hint">全局切换保留角色独立配置，进行中的回复不受影响。{apiPresets.some(preset => llmApiType(preset.config) === 'anthropic') && 'Anthropic 支持图文、工具与原生 Messages；后台使用需 Worker 支持。'}</p>
    </div>
    <footer className="navigation-api-footer"><button type="button" disabled={busy} onClick={onOpenSettings}><SlidersHorizontal size={16} />打开完整 API 设置<ArrowRight size={14} /></button></footer>
  </dialog>;
}
