import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import type { ImageGenerationApi, ImageGenerationConfig, ImageGenerationProvider, ImagePromptPreset } from '../../types';
import { DEFAULT_IMAGE_CAPABILITY, DEFAULT_IMAGE_INSTRUCTION } from '../../utils/chatImageConfig';
import { normalizeApiBaseUrl, normalizeApiCredential } from '../../utils/apiConfigNormalize';
import { extractModelIds } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';
import {
    DEFAULT_NAI_MODEL, DEFAULT_OAI_MODEL, NAI_DEFAULTS, NAI_MAX_SEED, NAI_MODEL_OPTIONS, NAI_SAMPLER_OPTIONS, NAI_SIZE_PRESETS, NAI_UC_PRESET_OPTIONS,
    OAI_MODEL_SUGGESTIONS, OAI_RETIRED_MODELS, isNaiV4, naiCostWarning, naiNoiseSchedule, naiNoiseScheduleOptions, naiParamError,
    oaiQualityOptions, oaiSizeChoice, oaiSizeError, oaiSizeOptions, oaiSupportsGptImageOptions, resolveOaiSize, type ParamOption,
} from '../../utils/imageGenerationParams';

const field = 'w-full rounded-xl border border-slate-200 p-3 text-sm bg-white';
const hint = 'block mt-1 text-[11px] text-slate-400';

function Select<T extends string | number>({ label, value, options, onChange, note }: {
    label: string; value: T; options: ParamOption<T>[]; onChange: (value: T) => void; note?: string;
}) {
    return <label className="block text-xs">{label}
        <select aria-label={label} className={field + ' mt-1'} value={String(value)}
            onChange={e => onChange(options.find(option => String(option.value) === e.target.value)!.value)}>
            {options.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
        </select>
        {note && <span className={hint}>{note}</span>}
    </label>;
}

/** 数字输入：清空 = undefined（使用默认值） */
function NumberInput({ label, value, placeholder, onChange, min, max, step, note }: {
    label: string; value?: number; placeholder?: string; onChange: (value: number | undefined) => void;
    min?: number; max?: number; step?: number; note?: string;
}) {
    return <label className="block text-xs">{label}
        <input aria-label={label} type="number" min={min} max={max} step={step} className={field + ' mt-1'}
            value={value ?? ''} placeholder={placeholder}
            onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
        {note && <span className={hint}>{note}</span>}
    </label>;
}

function Toggle({ label, checked, onChange, note }: { label: string; checked: boolean; onChange: (value: boolean) => void; note?: string }) {
    return <label className="block text-xs">
        <span className="flex items-center justify-between gap-3">{label}<input type="checkbox" aria-label={label} checked={checked} onChange={e => onChange(e.target.checked)} /></span>
        {note && <span className={hint}>{note}</span>}
    </label>;
}

function OaiParams({ api, set }: { api: ImageGenerationApi; set: (patch: Partial<ImageGenerationApi>) => void }) {
    const sizes = oaiSizeOptions(api.model);
    const sizeValue = oaiSizeChoice(api);
    const sizeError = oaiSizeError(api.model, resolveOaiSize(api));
    const qualities = oaiQualityOptions(api.model);
    const gptOptions = oaiSupportsGptImageOptions(api.model);
    const compressible = api.outputFormat === 'jpeg' || api.outputFormat === 'webp';
    return <>
        {OAI_RETIRED_MODELS[api.model.trim()] && <p className="text-xs text-rose-500">{OAI_RETIRED_MODELS[api.model.trim()]}</p>}
        <Select label="尺寸" value={sizeValue} options={sizes} onChange={size => set({ size })} />
        {sizeValue === 'custom' && <div className="grid grid-cols-2 gap-2">
            <NumberInput label="宽度" value={api.width} placeholder="1024" step={16} onChange={width => set({ width })} />
            <NumberInput label="高度" value={api.height} placeholder="1024" step={16} onChange={height => set({ height })} />
        </div>}
        {sizeValue === 'custom' && <p className="text-[11px] text-slate-400">gpt-image-2 / 2.5 系列：宽高都是 16 的倍数，长宽比 1:3～3:1，最大 3840x2160；超过 2560x1440 官方标注为实验性。</p>}
        {sizeError && <p className="text-xs text-rose-500">{sizeError}</p>}
        <Select label="画质" value={api.quality && qualities.some(o => o.value === api.quality) ? api.quality : ''}
            options={[{ value: '', label: '不指定（接口默认）' }, ...qualities]} onChange={quality => set({ quality: quality || undefined })}
            note="画质越高越慢、越贵。" />
        {gptOptions && <>
            <Select label="背景" value={api.background || 'auto'} onChange={background => set({ background })}
                options={[{ value: 'auto', label: '自动' }, { value: 'opaque', label: '不透明' }, { value: 'transparent', label: '透明' }]}
                note="透明背景需要 PNG 或 WebP 格式。" />
            {api.background === 'transparent' && api.outputFormat === 'jpeg' && <p className="text-xs text-rose-500">透明背景不能用 JPEG，请改成 PNG 或 WebP。</p>}
            <Select label="输出格式" value={api.outputFormat || ''} onChange={format => set({ outputFormat: (format || undefined) as ImageGenerationApi['outputFormat'] })}
                options={[{ value: '', label: '不指定（PNG）' }, { value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }]} />
            {compressible && <NumberInput label="压缩率（0～100）" value={api.outputCompression} placeholder="100" min={0} max={100} step={1}
                onChange={outputCompression => set({ outputCompression })} note="只对 JPEG / WebP 生效，默认 100 表示不压缩。" />}
            <Select label="内容审核" value={api.moderation || 'auto'} onChange={moderation => set({ moderation })}
                options={[{ value: 'auto', label: '标准（默认）' }, { value: 'low', label: '宽松 low' }]} />
        </>}
        <p className="text-[11px] text-slate-400">没改的参数不会发送，交给接口默认值；第三方 OAI 兼容中转如果不认识某个参数会报错，可以改回「不指定」。</p>
    </>;
}

function NaiParams({ api, set }: { api: ImageGenerationApi; set: (patch: Partial<ImageGenerationApi>) => void }) {
    const v4 = isNaiV4(api.model);
    const sizeKey = `${api.width ?? NAI_DEFAULTS.width}x${api.height ?? NAI_DEFAULTS.height}`;
    const preset = NAI_SIZE_PRESETS.some(option => option.value === sizeKey) ? sizeKey : 'custom';
    const error = naiParamError(api);
    const cost = naiCostWarning(api);
    return <>
        <Select label="画布尺寸" value={preset} options={[...NAI_SIZE_PRESETS, { value: 'custom', label: '自定义' }]}
            onChange={value => { if (value !== 'custom') { const [width, height] = value.split('x').map(Number); set({ width, height }); } else set({ width: api.width ?? NAI_DEFAULTS.width, height: (api.height ?? NAI_DEFAULTS.height) + 64 }); }} />
        {preset === 'custom' && <div className="grid grid-cols-2 gap-2">
            <NumberInput label="宽度" value={api.width} placeholder={String(NAI_DEFAULTS.width)} min={64} max={4096} step={64} onChange={width => set({ width })} />
            <NumberInput label="高度" value={api.height} placeholder={String(NAI_DEFAULTS.height)} min={64} max={4096} step={64} onChange={height => set({ height })} />
        </div>}
        <div className="grid grid-cols-2 gap-2">
            <NumberInput label="步数 Steps" value={api.steps} placeholder={String(NAI_DEFAULTS.steps)} min={1} max={50} step={1} onChange={steps => set({ steps })} />
            <NumberInput label="提示词引导 Guidance" value={api.scale} placeholder={String(NAI_DEFAULTS.scale)} min={0} max={10} step={0.1} onChange={scale => set({ scale })} />
        </div>
        <NumberInput label="引导缩放 Prompt Guidance Rescale" value={api.cfgRescale} placeholder={String(NAI_DEFAULTS.cfgRescale)} min={0} max={1} step={0.02}
            onChange={cfgRescale => set({ cfgRescale })} note="0～1。引导调高后画面发灰、过饱和时可以加一点。" />
        <Select label="采样器 Sampler" value={api.sampler || NAI_DEFAULTS.sampler} options={NAI_SAMPLER_OPTIONS} onChange={sampler => set({ sampler })} />
        <Select label="噪声调度 Noise Schedule" value={naiNoiseSchedule(api)} options={naiNoiseScheduleOptions(api.model)}
            onChange={noiseSchedule => set({ noiseSchedule })} note={v4 ? 'V4 / V4.5 模型没有 Native，默认 Karras。' : undefined} />
        <NumberInput label="种子 Seed" value={api.seed} placeholder="留空 = 每次随机" min={0} max={NAI_MAX_SEED} step={1}
            onChange={seed => set({ seed })} note="固定种子 + 同样的提示词可以画出很接近的图。" />
        <Toggle label="自动添加质量标签" checked={api.qualityToggle ?? NAI_DEFAULTS.qualityToggle} onChange={qualityToggle => set({ qualityToggle })} />
        <Select label="负面提示词预设 UC Preset" value={api.ucPreset ?? NAI_DEFAULTS.ucPreset} options={NAI_UC_PRESET_OPTIONS} onChange={ucPreset => set({ ucPreset })} />
        {!v4 && <>
            <Toggle label="SMEA" checked={api.smea === true} onChange={smea => set({ smea, ...(smea ? {} : { smeaDyn: false }) })} note="只有 V3 模型有，大图细节更稳。" />
            {api.smea && <Toggle label="SMEA DYN" checked={api.smeaDyn === true} onChange={smeaDyn => set({ smeaDyn })} />}
        </>}
        <label className="block text-xs">负面提示词<textarea aria-label="NAI 负面提示词" className={field + ' mt-1'} value={api.negativePrompt || ''} onChange={e => set({ negativePrompt: e.target.value })} /></label>
        {error && <p className="text-xs text-rose-500">{error}</p>}
        {cost && <p className="text-xs text-amber-600">{cost}</p>}
        <p className="text-[11px] text-slate-400">参数按 NovelAI 网页版整理；官方文档暂时无法核对，如果生图报错，请先把参数改回默认。</p>
    </>;
}

export default function ImageGenerationSettings({ value, onChange }: { value: ImageGenerationConfig; onChange: (value: ImageGenerationConfig) => void }) {
    const { apiPresets } = useOS();
    const [provider, setProvider] = useState<ImageGenerationProvider>('oai');
    const [editing, setEditing] = useState<ImagePromptPreset | null>(null);
    const [models, setModels] = useState<string[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelStatus, setModelStatus] = useState('');
    const api: ImageGenerationApi = value[provider] || { baseUrl: provider === 'oai' ? 'https://api.openai.com/v1' : 'https://image.novelai.net', apiKey: '', model: provider === 'oai' ? DEFAULT_OAI_MODEL : DEFAULT_NAI_MODEL };
    const set = (patch: Partial<ImageGenerationApi>) => onChange({ ...value, [provider]: { ...api, ...patch } });
    const presets = value.presets?.[provider] || [];
    const modelListId = 'image-model-' + provider;
    const fetchModels = async () => {
        const base = normalizeApiBaseUrl(api.baseUrl).replace(/\/images\/generations$/, '');
        if (!base) { setModelStatus('请先填写 API 地址'); return; }
        setLoadingModels(true); setModelStatus('正在拉取模型...'); setModels([]);
        try {
            const response = await fetch(base + '/models', { method: 'GET', headers: { Authorization: 'Bearer ' + normalizeApiCredential(api.apiKey) } });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const result = extractModelIds(await safeResponseJson(response));
            setModels(result);
            setModelStatus(result.length ? `获取到 ${result.length} 个模型` : '模型列表为空或格式不兼容');
        } catch (error) { setModelStatus('拉取模型失败：' + (error instanceof Error ? error.message : '网络错误')); }
        finally { setLoadingModels(false); }
    };
    return <div className="space-y-3 rounded-2xl border border-slate-200 p-4">
        <h3 className="text-sm font-bold">聊天生图 API 与提示词预设</h3>
        <p className="text-xs text-slate-500">两套接口分别保存。在神经链接为角色选择提示词，在聊天设置开启自动发图；加号中可手动生图。修改后点下方“保存其他 API”。</p>
        <label className="block text-xs">共用生图能力说明<textarea aria-label="共用生图能力说明" className={field + ' h-24 mt-1'} value={value.systemPrompt ?? ''} placeholder={DEFAULT_IMAGE_CAPABILITY} onChange={e => onChange({ ...value, systemPrompt: e.target.value })} /></label>
        <label className="block text-xs">默认生图文字 API<select aria-label="默认生图文字 API" className={field + " mt-1"} value={value.textApiPresetId || ""} onChange={e => onChange({ ...value, textApiPresetId: e.target.value || undefined })}><option value="">请选择已保存的文字 API 预设</option>{value.textApiPresetId && !apiPresets.some(p => p.id === value.textApiPresetId) && <option value={value.textApiPresetId}>原预设已删除，请重新选择</option>}{apiPresets.map(p => <option key={p.id} value={p.id}>{p.group ? p.group + " / " : ""}{p.name}</option>)}</select></label><p className="text-xs text-slate-500">专门整理图片提示词。可在神经链接为角色覆盖；不写入聊天或角色记忆。可先在 API 配置中保存一套独立的文字模型预设。</p>
        <div className="flex gap-2">{(['oai', 'nai'] as const).map(p => <button type="button" key={p} aria-pressed={provider === p} className={'px-4 py-2 rounded-xl text-sm ' + (provider === p ? 'bg-primary text-white' : 'bg-slate-100')} onClick={() => { setProvider(p); setEditing(null); }}>{p === 'oai' ? 'OAI 兼容接口' : 'NovelAI'}</button>)}</div>
        <label className="block text-xs">API 地址<input aria-label={provider + ' baseUrl'} type="text" autoComplete="off" spellCheck={false} className={field + ' mt-1'} value={api.baseUrl} onChange={e => set({ baseUrl: e.target.value })} /></label>
        <label className="block text-xs">API Key<input aria-label={provider + ' apiKey'} type="password" autoComplete="off" spellCheck={false} className={field + ' mt-1'} value={api.apiKey} onChange={e => set({ apiKey: e.target.value })} /></label>
        <label className="block text-xs">模型名称<span className="flex items-center gap-2"><input aria-label={provider + ' model'} type="text" list={modelListId} autoComplete="off" spellCheck={false} className={field + ' mt-1 min-w-0'} value={api.model} onChange={e => set({ model: e.target.value })} />
            {provider === 'oai' && <button type="button" className="shrink-0 text-xs text-primary" disabled={loadingModels} onClick={fetchModels}>{loadingModels ? '拉取中...' : '拉取模型'}</button>}</span>
            <datalist id={modelListId}>{(provider === 'oai' ? Array.from(new Set([...models, ...OAI_MODEL_SUGGESTIONS])).map(m => ({ value: m, label: m })) : NAI_MODEL_OPTIONS).map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</datalist>
            <span className={hint}>可以从列表里选，也可以手填中转服务商给的模型名。</span>
            {provider === 'oai' && modelStatus && <span role="status" className={hint}>{modelStatus}</span>}
        </label>
        <div className="space-y-3 rounded-xl bg-slate-50 p-3">
            <h4 className="text-xs font-bold">{provider === 'oai' ? 'OAI 生图参数' : 'NovelAI 生图参数'}</h4>
            {provider === 'oai' ? <OaiParams api={api} set={set} /> : <NaiParams api={api} set={set} />}
        </div>
        <p className="text-xs text-slate-500">官方接口使用网络代理转发，需要代理同步更新。自定义地址须支持浏览器跨域。不自动换模型或重试付费请求。</p>
        <div className="flex justify-between items-center"><h4 className="text-xs font-bold">{provider.toUpperCase()} 生成要求 · 多版预设</h4><button type="button" className="text-xs text-primary" onClick={() => setEditing(provider === 'oai' ? { id: crypto.randomUUID(), name: '', positivePrompt: '', negativePrompt: '' } : { id: crypto.randomUUID(), name: '', content: '' })}>＋ 新建版本</button></div>
        {presets.map(p => <div key={p.id} className="flex items-center gap-2 p-2 bg-slate-50 rounded-xl"><span className="flex-1 text-xs break-all">{p.name}</span><button type="button" className="text-xs text-primary" onClick={() => setEditing({ ...p })}>编辑</button><button type="button" className="text-xs text-rose-500" onClick={() => { if (window.confirm('删除这个提示词版本？已选择它的角色需要重新选择。')) onChange({ ...value, presets: { ...value.presets, [provider]: presets.filter(item => item.id !== p.id) } }); }}>删除</button></div>)}
        {!presets.length && <p className="text-xs text-slate-400">暂无版本，可先新建；角色也可使用内置默认要求。</p>}
        {editing && <div className="space-y-2 p-3 border rounded-xl"><input aria-label="生图提示词版本名称" className={field} placeholder="版本名称" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} />{provider === 'oai' ? <>
            <label className="block text-xs">正向提示词（Positive Prompt）<textarea aria-label="OAI 正向提示词" className={field + ' h-40 mt-1'} value={editing.positivePrompt ?? editing.content ?? ''} onChange={e => setEditing({ ...editing, positivePrompt: e.target.value })} /></label>
            <label className="block text-xs">反向提示词（Negative Prompt）<textarea aria-label="OAI 反向提示词" className={field + ' h-40 mt-1'} value={editing.negativePrompt ?? ''} onChange={e => setEditing({ ...editing, negativePrompt: e.target.value })} /></label>
        </> : <textarea aria-label="生图生成要求" className={field + ' h-40'} placeholder={DEFAULT_IMAGE_INSTRUCTION} value={editing.content ?? ''} onChange={e => setEditing({ ...editing, content: e.target.value })} />}<div className="flex gap-3"><button type="button" disabled={!editing.name.trim() || (provider === 'nai' && !editing.content?.trim())} className="text-primary text-xs disabled:opacity-40" onClick={() => { const saved = provider === 'oai' ? { id: editing.id, name: editing.name.trim(), positivePrompt: editing.positivePrompt ?? editing.content ?? '', negativePrompt: editing.negativePrompt ?? '' } : { ...editing, name: editing.name.trim() }; onChange({ ...value, [provider]: api, presets: { ...value.presets, [provider]: [...presets.filter(p => p.id !== editing.id), saved] } }); setEditing(null); }}>保存到草稿</button><button type="button" className="text-xs" onClick={() => setEditing(null)}>取消</button></div></div>}
    </div>;
}
