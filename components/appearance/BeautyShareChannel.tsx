import React, { useEffect, useState } from 'react';
import { AppID, type AppearancePreset } from '../../types';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { decorationPatches, validateDecoration, type DecorationPart, type DecorationPreset } from '../../utils/chatDecoration';
import { readBeautyPackage } from '../../utils/beautyShareClient';
import type { BeautyKind, BeautyShare } from '../../utils/beautyShareContract';
import { rememberBeautySource, decorationSourceKey, startBeautyUsage } from '../../utils/beautyUsage';
import BeautySharePanel from '../share/BeautySharePanel';
import { BeautyRepoLibrary } from '../share/BeautyRepoInvitation';

const CHAT_PRESETS = 'chat_decoration_presets_v1';
interface Props {
  presets: AppearancePreset[];
  onExport: (id: string) => Promise<Blob>;
  onImport: (file: File) => Promise<string>;
  onBusyChange: (busy: boolean) => void;
}
export default function BeautyShareChannel({ presets, onExport, onImport, onBusyChange }: Props) {
  const { characters, activeCharacterId, theme, applyAppearancePreset, addCustomTheme, updateCharacter, setActiveCharacterId, openApp, closeApp } = useOS();
  const [received, setReceived] = useState<{ kind: 'appearance'; id: string; name: string } | { kind: 'chat-decoration'; preset: DecorationPreset; name: string } | null>(null);
  const [target, setTarget] = useState(activeCharacterId || characters[0]?.id || '');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
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
  const receive = async (data: unknown, share: BeautyShare) => {
    setApplyError('');
    if (kind === 'appearance') {
      const id = await onImport(new File([JSON.stringify(data)], 'beauty-preset.json', { type: 'application/json' }));
      await rememberBeautySource(id, share);
      setReceived({ kind: 'appearance', id, name: (data as AppearancePreset).name }); return;
    }
    const preset = validateDecoration(data);
    // Read again before saving so an old snapshot cannot overwrite a newly saved preset.
    const raw = await DB.getAsset(CHAT_PRESETS);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) throw Error('聊天装扮预设读取失败，请重新打开后重试');
    const next = [preset, ...list.map(validateDecoration)];
    await DB.saveAsset(CHAT_PRESETS, JSON.stringify(next)); setSaved(next);
    await rememberBeautySource(await decorationSourceKey(preset), share);
    setTarget(activeCharacterId || characters[0]?.id || '');
    setReceived({ kind: 'chat-decoration', preset, name: preset.name });
  };
  const applyReceived = async () => {
    if (!received || applying) return;
    setApplying(true); onBusyChange(true); setApplyError('');
    try {
      if (received.kind === 'appearance') {
        await applyAppearancePreset(received.id);
        closeApp();
      } else {
        const character = characters.find(item => item.id === target);
        if (!character) throw Error('请选择要应用的角色');
        const changes = await decorationPatches(received.preset, Object.keys(received.preset.parts) as DecorationPart[], 'character', character, theme);
        if (changes.bubble) await addCustomTheme(changes.bubble);
        await updateCharacter(character.id, changes.character);
        await startBeautyUsage(await decorationSourceKey(received.preset), 'chat:' + character.id);
        setActiveCharacterId(character.id); openApp(AppID.Chat);
      }
      setReceived(null);
    } catch (error) { setApplyError(error instanceof Error ? error.message : '应用失败，请重试'); }
    finally { setApplying(false); onBusyChange(false); }
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
      onReceive={receive} receivedMessage="已保存到本机预设，可选择立即应用。"/>
    <BeautyRepoLibrary/>
    {received && <div role="dialog" aria-modal="true" aria-labelledby="beauty-apply-title" className="fixed inset-0 z-[100] bg-black/30 flex items-center justify-center p-5">
      <div className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-xl text-slate-700">
        <h3 id="beauty-apply-title" className="text-lg font-medium">是否立即应用？</h3>
        <p className="text-sm mt-3 break-words">「{received.name}」已保存到本机预设。</p>
        {received.kind === 'appearance' ? <p className="text-xs text-slate-500 mt-2">应用后返回桌面，查看新的主题效果。</p> : <>
          <label className="block text-sm mt-4">选择应用角色<select disabled={applying} value={target} onChange={e => setTarget(e.target.value)} className="block w-full mt-2 p-3 border rounded-xl">
            <option value="">请选择角色</option>{characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
          </select></label>
          <p className="text-xs text-slate-500 mt-2">应用整套预设后进入该角色的聊天。其他角色的装扮不变。{!characters.length && '暂无角色，可稍后创建角色再应用。'}</p>
        </>}
        {applyError && <p role="alert" className="text-sm text-red-600 mt-3">{applyError}</p>}
        <div className="flex justify-end gap-3 mt-5">
          <button disabled={applying} onClick={() => setReceived(null)} className="px-3 py-2 text-sm">暂不应用</button>
          <button disabled={applying || (received.kind === 'chat-decoration' && !target)} onClick={applyReceived} className="px-4 py-2 rounded-xl bg-slate-800 text-white text-sm disabled:opacity-40">{applying ? '正在应用…' : received.kind === 'appearance' ? '应用并查看桌面' : '应用并进入聊天'}</button>
        </div>
      </div>
    </div>}
  </div>;
}
