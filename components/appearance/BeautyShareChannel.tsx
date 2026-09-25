import React, { useEffect, useState } from 'react';
import type { AppearancePreset } from '../../types';
import { DB } from '../../utils/db';
import { validateDecoration, type DecorationPreset } from '../../utils/chatDecoration';
import { readBeautyPackage } from '../../utils/beautyShareClient';
import type { BeautyKind } from '../../utils/beautyShareContract';
import BeautySharePanel from '../share/BeautySharePanel';

const CHAT_PRESETS = 'chat_decoration_presets_v1';
interface Props {
  presets: AppearancePreset[];
  onExport: (id: string) => Promise<Blob>;
  onImport: (file: File) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}
export default function BeautyShareChannel({ presets, onExport, onImport, onBusyChange }: Props) {
  const [kind, setKind] = useState<BeautyKind>('appearance');
  const [saved, setSaved] = useState<DecorationPreset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    DB.getAsset(CHAT_PRESETS).then(raw => {
      const data = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(data)) throw Error('聊天装扮预设列表格式无效');
      const list = data.map(validateDecoration);
      if (alive) setSaved(list);
    }).catch(() => { if (alive) setError('聊天装扮预设读取失败，请重新打开此页。'); });
    return () => { alive = false; };
  }, []);
  const receive = async (data: unknown) => {
    if (kind === 'appearance') { await onImport(new File([JSON.stringify(data)], 'beauty-preset.json', { type: 'application/json' })); return; }
    const preset = validateDecoration(data);
    // Read again before saving so an old snapshot cannot overwrite a newly saved preset.
    const raw = await DB.getAsset(CHAT_PRESETS);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) throw Error('聊天装扮预设读取失败，请重新打开后重试');
    const next = [preset, ...list.map(validateDecoration)];
    await DB.saveAsset(CHAT_PRESETS, JSON.stringify(next)); setSaved(next);
  };
  return <div>
    <h2 className="text-lg font-medium text-slate-700">美化分享</h2>
    <p className="text-xs text-slate-500 leading-relaxed mt-2">把自己的美化提交审核，通过后获得分享码。收到作者的码，也可以在这里领取。</p>
    <div className="flex gap-2 mt-4" aria-label="美化类型">
      {([['appearance', '外观预设'], ['chat-decoration', '聊天装扮']] as const).map(([value, label]) => <button key={value} disabled={busy} aria-pressed={kind === value} onClick={() => setKind(value)} className={`px-4 py-2 rounded-xl text-sm border ${kind === value ? 'bg-white text-primary border-primary' : 'text-slate-500 border-slate-200'}`}>{label}</button>)}
    </div>
    <p className="text-xs text-slate-500 mt-3">{kind === 'appearance' ? '先在「外观预设」保存当前搭配，再选择投稿；也支持上传已有预设文件。' : '可选择聊天装扮中已保存的预设，或上传导出的预设文件。领取后存入聊天装扮的「我的预设」，由你选择应用。'}</p>
    {error && kind === 'chat-decoration' && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <BeautySharePanel key={kind} kind={kind} defaultOpen initialTab="submit" onBusyChange={value => { setBusy(value); onBusyChange(value); }}
      sources={kind === 'appearance' ? presets.map(preset => ({ id: preset.id, name: preset.name, read: async () => readBeautyPackage(new File([await onExport(preset.id)], 'preset.zip'), 'appearance') })) : saved.map((preset, index) => ({ id: `chat-${index}`, name: preset.name, read: async () => preset }))}
      onReceive={receive} receivedMessage={kind === 'chat-decoration' ? '已存入聊天装扮的「我的预设」，请到聊天装扮中选择应用。' : undefined}/>
  </div>;
}
