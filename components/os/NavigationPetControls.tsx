import React, { useId, useState } from 'react';
import { CLAWD_FORM_SCALE_MAX, CLAWD_FORM_SCALE_MIN, CLAWD_FORMS, setNavigationPet, setNavigationPetFormScale, useNavigationPetForm, useNavigationPetPreferences, type NavigationPetSelection } from '../../utils/navigationBallPet';

export default function NavigationPetControls({ compact = false }: { compact?: boolean }) {
  const preferences = useNavigationPetPreferences();
  const automatic = useNavigationPetForm();
  const id = useId();
  const [error, setError] = useState('');
  return <div className={`navigation-pet-controls${compact ? ' navigation-pet-controls-compact' : ''}`}>
    <label htmlFor={id}>Clawd 形态{preferences.selection === 'auto' && <small>当前：{CLAWD_FORMS.find(([form]) => form === automatic)?.[1]}</small>}</label>
    <select id={id} aria-label="Clawd 形态" value={preferences.selection} onChange={event => {
      try { setNavigationPet({ selection: event.target.value as NavigationPetSelection }); setError(''); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); }
    }}>
      <option value="auto">自动跟随聊天</option>
      {CLAWD_FORMS.map(([form, label]) => <option key={form} value={form}>{label}</option>)}
    </select>
    {!compact && <p>手动选择后保持该形态；选择“自动跟随聊天”可恢复。非流式显示等待与完成状态。</p>}
    {!compact && <div className="navigation-pet-scale-list">
      <span className="navigation-pet-scale-title">各形态尺寸</span>
      {CLAWD_FORMS.map(([form, label]) => <label key={form} className="navigation-pet-scale-row">
        <span>{label}</span><output>{Math.round(preferences.scales[form] * 100)}%</output>
        <input aria-label={`${label}尺寸`} type="range" min={CLAWD_FORM_SCALE_MIN * 100} max={CLAWD_FORM_SCALE_MAX * 100} step="1"
          value={Math.round(preferences.scales[form] * 100)} onChange={event => setNavigationPetFormScale(form, Number(event.target.value) / 100)} />
      </label>)}
    </div>}
    {error && <p role="status">{error}</p>}
  </div>;
}
