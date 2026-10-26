import React, { useId, useState } from 'react';
import { CLAWD_FORMS, setNavigationPet, useNavigationPetForm, useNavigationPetPreferences, type NavigationPetSelection } from '../../utils/navigationBallPet';

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
    {error && <p role="status">{error}</p>}
  </div>;
}
