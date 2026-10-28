import React, { useEffect, useId, useRef, useState } from 'react';
import { resetNavigationBallPosition, setNavigationBallEnabled, setNavigationBallSlot, useNavigationBallEnabled, useNavigationBallSlots } from '../../utils/navigationBall';
import { describeNavigationShortcut, type ShortcutCharacter, type ShortcutWorld, type ShortcutResources } from '../../utils/navigationShortcuts';
import { useSettingsFocus } from '../../utils/settingsNavigation';
import { useOS } from '../../context/OSContext';
import { AppID } from '../../types';
import { processImage } from '../../utils/file';
import { CLAWD_SIZE_MAX, CLAWD_SIZE_MIN, NAVIGATION_BALL_SIZE_MIN, NAVIGATION_BALL_SIZE_MAX, navigationBallShapeRadius, resetNavigationBallAppearance, setNavigationBallAppearance, useNavigationBallAppearance, type NavigationBallAppearance, type NavigationBallShape } from '../../utils/navigationBallAppearance';
import NavigationBallFace from '../os/NavigationBallFace';
import NavigationPetControls from '../os/NavigationPetControls';
import { setNavigationPet, useNavigationPetPreferences } from '../../utils/navigationBallPet';
const NavigationSlotPicker = React.lazy(() => import('./NavigationSlotPicker'));
// Only mounted when a slot is being edited. Project titles, never message/book bodies.
function SlotPickerWithResources(props: React.ComponentProps<typeof NavigationSlotPicker>) {
  const { groups = [], novels = [], songs = [], worldbooks = [] } = useOS();
  const resources = React.useMemo(() => ({
    [AppID.GroupChat]: groups.map(item => ({ id: item.id, name: item.name })),
    [AppID.Novel]: novels.map(item => ({ id: item.id, name: item.title })),
    [AppID.Songwriting]: songs.map(item => ({ id: item.id, name: item.title })),
    [AppID.Worldbook]: worldbooks.map(item => ({ id: item.id, name: item.title })),
  }), [groups, novels, songs, worldbooks]);
  return <NavigationSlotPicker {...props} resources={props.resources || resources} />;
}
export default function NavigationBallSettings({ characters = [], loadWorlds, resources }: { characters?: readonly ShortcutCharacter[]; loadWorlds?: () => Promise<ShortcutWorld[]>; resources?: ShortcutResources }) {
  const enabled = useNavigationBallEnabled();
  const slots = useNavigationBallSlots();
  const appearance = useNavigationBallAppearance();
  const pet = useNavigationPetPreferences();
  const controlledSize = pet.enabled ? appearance.clawdSize : appearance.size;
  const [sizeDraft, setSizeDraft] = useState(String(controlledSize));
  useEffect(() => setSizeDraft(String(controlledSize)), [controlledSize]);
  const imageInput = useRef<HTMLInputElement>(null);
  const uploadVersion = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [appearanceStatus, setAppearanceStatus] = useState('');
  useEffect(() => () => { uploadVersion.current += 1; }, []);
  const updateAppearance = (patch: Partial<NavigationBallAppearance>) => {
    try { setNavigationBallAppearance(patch); setAppearanceStatus('外观已保存在本机'); }
    catch (error) { setAppearanceStatus(error instanceof Error ? error.message : '保存失败'); }
  };
  const commitSize = () => {
    const input = sizeDraft.trim() ? Number(sizeDraft) : controlledSize;
    const min = pet.enabled ? CLAWD_SIZE_MIN : NAVIGATION_BALL_SIZE_MIN;
    const max = pet.enabled ? CLAWD_SIZE_MAX : NAVIGATION_BALL_SIZE_MAX;
    const size = Number.isFinite(input) ? Math.round(Math.min(max, Math.max(min, input))) : controlledSize;
    setSizeDraft(String(size)); updateAppearance(pet.enabled ? { clawdSize: size } : { size });
  };
  const uploadImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setAppearanceStatus('请选择不超过 5MB 的 PNG、JPEG、WebP，或不超过 580KB 的 GIF'); return;
    }
    if (file.type === 'image/gif' && file.size > 580 * 1024) { setAppearanceStatus('GIF 请控制在 580KB 以内，以保留完整动画并保存到本机'); return; }
    const version = ++uploadVersion.current;
    setUploading(true); setAppearanceStatus('正在处理图片…');
    try {
      const image = await processImage(file, file.type === 'image/gif' ? { skipCompression: true } : { maxWidth: 512, quality: 0.9 });
      if (version !== uploadVersion.current) return;
      setNavigationBallAppearance({ image }); setAppearanceStatus('图片已保存在本机');
    } catch (error) {
      if (version === uploadVersion.current) setAppearanceStatus(error instanceof Error ? error.message : '图片处理失败');
    } finally { if (version === uploadVersion.current) setUploading(false); }
  };
  const section = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const contentId = useId();
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [positionReset, setPositionReset] = useState(false);
  useSettingsFocus('navigation', () => { setExpanded(true); setFocusRequest(value => value + 1); });
  useEffect(() => {
    if (focusRequest) section.current?.scrollIntoView({ block: 'start' });
  }, [focusRequest]);
  return <section ref={section} className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
    <button type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}
      className={`flex items-center gap-2 w-full text-left ${expanded ? 'mb-4' : ''}`}>
      <div className="p-2 bg-slate-100 rounded-xl text-slate-600">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} className="w-4 h-4">
          <rect x="3" y="3" width="18" height="18" rx="6" /><circle cx="12" cy="12" r="4" />
        </svg>
      </div>
      <h2 className="text-sm font-semibold text-slate-600 tracking-wider">悬浮球设置</h2>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
        className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
      </svg>
    </button>
    {expanded && <div id={contentId}>
    <div className="flex items-center justify-between gap-4">
      <div><h3 className="text-xs font-medium text-slate-600">开启快捷导航悬浮球</h3>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">拖动调整位置，点开可返回、回桌面或打开快捷入口。</p></div>
      <button type="button" role="switch" aria-label="开启快捷导航悬浮球" aria-checked={enabled}
        onClick={() => setNavigationBallEnabled(!enabled)}
        className={`h-7 w-12 shrink-0 rounded-full p-1 transition-colors ${enabled ? 'bg-primary' : 'bg-slate-200'}`}>
        <span className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-5' : ''}`} />
      </button>
    </div>
    <div className="mt-5 border-t border-slate-100 pt-4 space-y-4">
      <fieldset>
        <legend className="mb-2 text-xs text-slate-500">悬浮球外观模式</legend>
        <div className="flex flex-wrap gap-2">
          {([[false, '普通 / 自定义图片'], [true, 'Clawd 动图']] as const).map(([enabled, label]) => <button key={label} type="button" aria-pressed={pet.enabled === enabled}
            onClick={() => {
              uploadVersion.current += 1; setUploading(false);
              try { setNavigationPet({ enabled }); setAppearanceStatus('外观模式已保存在本机'); }
              catch (error) { setAppearanceStatus(error instanceof Error ? error.message : '保存失败'); }
            }} className={`rounded-xl border px-3 py-2 text-xs ${pet.enabled === enabled ? 'border-primary text-primary bg-primary/5' : 'border-slate-200 text-slate-500'}`}>{label}</button>)}
        </div>
      </fieldset>
      {pet.enabled && <><NavigationPetControls /><p className="text-[11px] leading-relaxed text-slate-400">动图从 <a href="https://github.com/0k46oe/clawd-on-desk" target="_blank" rel="noopener noreferrer" className="underline">Clawd on Desk</a> 仓库的固定版本加载；加载失败时显示默认球。点开悬浮球也能快速切换形态。</p></>}
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-slate-100" aria-label="悬浮球外观预览">
          <div className="navigation-ball-face-preview" data-custom-image={pet.enabled || !!appearance.image} data-pet={pet.enabled} data-image-border={appearance.imageBorder}
            style={{ borderRadius: navigationBallShapeRadius[appearance.shape], opacity: appearance.opacity, '--navigation-ball-size': `${Math.min(controlledSize, 64)}px` } as React.CSSProperties}>
            <NavigationBallFace appearance={appearance} />
          </div>
        </div>
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-slate-600">{pet.enabled ? 'Clawd 动图预览' : '自定义外观'}</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{pet.enabled ? '保留透明背景和完整形象，大小在下方调整。原有自定义图片保留。' : '静态图片最长边压缩至 512px；GIF 保留动画，限 580KB。图片仅保存在本机。'}</p>
          {!pet.enabled && <><input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传悬浮球图片" className="hidden" onChange={event => { void uploadImage(event); }} />
          <button type="button" disabled={uploading} onClick={() => imageInput.current?.click()} className="mt-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600 disabled:opacity-50">{uploading ? '处理中…' : '上传图片 / GIF'}</button>
          {appearance.image && <button type="button" disabled={uploading} onClick={() => updateAppearance({ image: '' })} className="ml-2 text-xs text-slate-400">移除图片</button>}</>}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between gap-3">
            <label htmlFor={`${contentId}-size`} className="text-xs text-slate-500">{pet.enabled ? 'Clawd 基础尺寸' : '悬浮球尺寸'}</label>
          <span className="flex items-center gap-1 text-xs text-slate-400"><input aria-label={pet.enabled ? 'Clawd 基础尺寸数值' : '悬浮球尺寸数值'} type="number" min={pet.enabled ? CLAWD_SIZE_MIN : NAVIGATION_BALL_SIZE_MIN} max={pet.enabled ? CLAWD_SIZE_MAX : NAVIGATION_BALL_SIZE_MAX} step="1"
            value={sizeDraft} onChange={event => setSizeDraft(event.target.value)} onBlur={commitSize} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            className="w-16 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-right text-xs text-slate-600" />px</span>
        </div>
        <input id={`${contentId}-size`} aria-label={pet.enabled ? 'Clawd 基础尺寸' : '悬浮球尺寸'} type="range" min={pet.enabled ? CLAWD_SIZE_MIN : NAVIGATION_BALL_SIZE_MIN} max={pet.enabled ? CLAWD_SIZE_MAX : NAVIGATION_BALL_SIZE_MAX} step="1" value={controlledSize}
          onChange={event => updateAppearance(pet.enabled ? { clawdSize: Number(event.target.value) } : { size: Number(event.target.value) })} className="mt-3 block w-full accent-slate-500" />
        <p className="mt-1 text-[11px] text-slate-400">{pet.enabled ? 'Clawd 独立基础尺寸；下方可分别微调每张 GIF。' : '24～160px，默认 44px；可拖动滑块或输入具体数值。'}</p>
      </div>
      <fieldset>
        <legend className="mb-2 text-xs text-slate-500">形状</legend>
        <div className="flex flex-wrap gap-2">
          {([['circle', '圆形'], ['square', '正方形'], ['rounded', '圆角正方形']] as const).map(([shape, label]) => <button key={shape} type="button" aria-pressed={appearance.shape === shape}
            onClick={() => updateAppearance({ shape: shape as NavigationBallShape })} className={`rounded-xl border px-3 py-2 text-xs ${appearance.shape === shape ? 'border-primary text-primary bg-primary/5' : 'border-slate-200 text-slate-500'}`}>{label}</button>)}
        </div>
      </fieldset>
      {(appearance.image || pet.enabled) && <div className="flex items-center justify-between gap-4">
        <div><span className="text-xs text-slate-500">图片边框</span><p className="mt-1 text-[11px] leading-relaxed text-slate-400">关闭时移除外框、底色和阴影；默认悬浮球仍保留原边框。</p></div>
        <button type="button" role="switch" aria-label="悬浮球图片边框" aria-checked={appearance.imageBorder}
          onClick={() => updateAppearance({ imageBorder: !appearance.imageBorder })}
          className={`h-6 w-11 shrink-0 rounded-full p-1 transition-colors ${appearance.imageBorder ? 'bg-primary' : 'bg-slate-200'}`}>
          <span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${appearance.imageBorder ? 'translate-x-5' : ''}`} />
        </button>
      </div>}
      <label className="block text-xs text-slate-500">不透明度 · {Math.round(appearance.opacity * 100)}%
        <input aria-label="悬浮球不透明度" type="range" min="10" max="100" step="1" value={Math.round(appearance.opacity * 100)}
          onChange={event => updateAppearance({ opacity: Number(event.target.value) / 100 })} className="mt-3 block w-full accent-slate-500" />
      </label>
      <p className="text-[11px] text-slate-400">仅改变球体，展开菜单保持清晰；最低保留 10% 可见度。</p>
      <button type="button" onClick={() => {
        uploadVersion.current += 1; setUploading(false);
        try { setNavigationPet({ enabled: false, selection: 'auto' }); resetNavigationBallAppearance(); setAppearanceStatus('已恢复默认外观，位置与快捷入口已保留'); }
        catch (error) { setAppearanceStatus(error instanceof Error ? error.message : '恢复失败'); }
      }} className="rounded-xl bg-slate-100 px-4 py-2.5 text-xs text-slate-600">恢复默认外观</button>
      {appearanceStatus && <p role="status" className="text-[11px] leading-relaxed text-slate-500">{appearanceStatus}</p>}
    </div>
    <div className="mt-4 border-t border-slate-100 pt-4">
      <button type="button" onClick={() => { resetNavigationBallPosition(); setPositionReset(true); }}
        className="rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-200">悬浮球复位抢救</button>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400" role="status">{positionReset ? '位置已复位，开关和快捷入口均已保留。' : '找不到悬浮球或位置不顺手时，可恢复默认位置。快捷入口会保留。'}</p>
    </div>
    {enabled && <div className="mt-5 border-t border-slate-100 pt-4">
      <p className="mb-3 text-xs text-slate-500">自定义 App 槽位 · 仅保存在本机</p>
      {slots.map((shortcut, index) => {
        const label = describeNavigationShortcut(shortcut, characters);
        return <button type="button" key={index} aria-label={`配置悬浮球槽位 ${index + 1}`} onClick={() => setEditingSlot(index)}
          className="mb-2 flex w-full items-center gap-3 rounded-2xl bg-slate-50 px-3 py-3 text-left hover:bg-slate-100">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white text-xs text-slate-400">{index + 1}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-slate-600">{label.name}</span><span className="mt-1 block truncate text-[10px] text-slate-400">{label.detail}</span></span>
          <span className="text-slate-400" aria-hidden="true">›</span>
        </button>;
      })}
    </div>}
    {editingSlot !== null && <React.Suspense fallback={<p role="status" className="mt-3 text-xs text-slate-400">正在打开入口选择…</p>}>
      <SlotPickerWithResources slot={editingSlot} characters={characters} loadWorlds={loadWorlds} resources={resources}
        onSelect={shortcut => { setNavigationBallSlot(editingSlot, shortcut); setEditingSlot(null); }} onClose={() => setEditingSlot(null)} />
    </React.Suspense>}
    </div>}
  </section>;
}
