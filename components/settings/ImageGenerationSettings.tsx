import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import type { ImageGenerationConfig, ImageGenerationProvider, ImagePromptPreset } from '../../types';
import { DEFAULT_IMAGE_CAPABILITY, DEFAULT_IMAGE_INSTRUCTION } from '../../utils/chatImageConfig';

export default function ImageGenerationSettings({ value, onChange }: { value: ImageGenerationConfig; onChange: (value: ImageGenerationConfig) => void }) {
    const { apiPresets } = useOS();
    const [provider, setProvider] = useState<ImageGenerationProvider>('oai');
    const [editing, setEditing] = useState<ImagePromptPreset | null>(null);
    const api = value[provider] || { baseUrl: provider === 'oai' ? 'https://api.openai.com/v1' : 'https://image.novelai.net', apiKey: '', model: provider === 'oai' ? 'gpt-image-1' : 'nai-diffusion-3' };
    const presets = value.presets?.[provider] || [];
    const field = 'w-full rounded-xl border border-slate-200 p-3 text-sm bg-white';
    return <div className="space-y-3 rounded-2xl border border-slate-200 p-4">
        <h3 className="text-sm font-bold">聊天生图 API 与提示词预设</h3>
        <p className="text-xs text-slate-500">两套接口分别保存。在神经链接为角色选择提示词，在聊天设置开启自动发图；加号中可手动生图。修改后点下方“保存其他 API”。</p>
        <label className="block text-xs">共用生图能力说明<textarea aria-label="共用生图能力说明" className={field + ' h-24 mt-1'} value={value.systemPrompt ?? ''} placeholder={DEFAULT_IMAGE_CAPABILITY} onChange={e => onChange({ ...value, systemPrompt: e.target.value })} /></label>
        <label className="block text-xs">默认生图文字 API<select aria-label="默认生图文字 API" className={field + " mt-1"} value={value.textApiPresetId || ""} onChange={e => onChange({ ...value, textApiPresetId: e.target.value || undefined })}><option value="">请选择已保存的文字 API 预设</option>{value.textApiPresetId && !apiPresets.some(p => p.id === value.textApiPresetId) && <option value={value.textApiPresetId}>原预设已删除，请重新选择</option>}{apiPresets.map(p => <option key={p.id} value={p.id}>{p.group ? p.group + " / " : ""}{p.name}</option>)}</select></label><p className="text-xs text-slate-500">专门整理图片提示词。可在神经链接为角色覆盖；不写入聊天或角色记忆。可先在 API 配置中保存一套独立的文字模型预设。</p>
        <div className="flex gap-2">{(['oai', 'nai'] as const).map(p => <button type="button" key={p} aria-pressed={provider === p} className={'px-4 py-2 rounded-xl text-sm ' + (provider === p ? 'bg-primary text-white' : 'bg-slate-100')} onClick={() => { setProvider(p); setEditing(null); }}>{p === 'oai' ? 'OAI 兼容接口' : 'NovelAI'}</button>)}</div>
        {(['baseUrl', 'apiKey', 'model'] as const).map(key => <label key={key} className="block text-xs">{key === 'baseUrl' ? 'API 地址' : key === 'apiKey' ? 'API Key' : '模型名称'}<input aria-label={provider + ' ' + key} type={key === 'apiKey' ? 'password' : 'text'} autoComplete="off" spellCheck={false} className={field + ' mt-1'} value={api[key]} onChange={e => onChange({ ...value, [provider]: { ...api, [key]: e.target.value } })} /></label>)}
        <div className="grid grid-cols-2 gap-2">{(['width', 'height'] as const).map(key => <label key={key} className="text-xs">{key === 'width' ? '宽度' : '高度'}<input aria-label={provider + ' ' + key} type="number" min={64} max={4096} step={64} className={field} value={api[key] ?? 1024} onChange={e => onChange({ ...value, [provider]: { ...api, [key]: Number(e.target.value) } })} /></label>)}</div>
        {provider === 'nai' && <label className="block text-xs">NAI 负面提示词<textarea className={field} value={api.negativePrompt || ''} onChange={e => onChange({ ...value, nai: { ...api, negativePrompt: e.target.value } })} /></label>}
        <p className="text-xs text-slate-500">官方接口使用网络代理转发，需要代理同步更新。自定义地址须支持浏览器跨域。不自动换模型或重试付费请求。</p>
        <div className="flex justify-between items-center"><h4 className="text-xs font-bold">{provider.toUpperCase()} 生成要求 · 多版预设</h4><button type="button" className="text-xs text-primary" onClick={() => setEditing({ id: crypto.randomUUID(), name: '', content: '' })}>＋ 新建版本</button></div>
        {presets.map(p => <div key={p.id} className="flex items-center gap-2 p-2 bg-slate-50 rounded-xl"><span className="flex-1 text-xs break-all">{p.name}</span><button type="button" className="text-xs text-primary" onClick={() => setEditing({ ...p })}>编辑</button><button type="button" className="text-xs text-rose-500" onClick={() => { if (window.confirm('删除这个提示词版本？已选择它的角色需要重新选择。')) onChange({ ...value, presets: { ...value.presets, [provider]: presets.filter(item => item.id !== p.id) } }); }}>删除</button></div>)}
        {!presets.length && <p className="text-xs text-slate-400">暂无版本，可先新建；角色也可使用内置默认要求。</p>}
        {editing && <div className="space-y-2 p-3 border rounded-xl"><input aria-label="生图提示词版本名称" className={field} placeholder="版本名称" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /><textarea aria-label="生图生成要求" className={field + ' h-40'} placeholder={DEFAULT_IMAGE_INSTRUCTION} value={editing.content} onChange={e => setEditing({ ...editing, content: e.target.value })} /><div className="flex gap-3"><button type="button" disabled={!editing.name.trim() || !editing.content.trim()} className="text-primary text-xs disabled:opacity-40" onClick={() => { onChange({ ...value, [provider]: api, presets: { ...value.presets, [provider]: [...presets.filter(p => p.id !== editing.id), { ...editing, name: editing.name.trim() }] } }); setEditing(null); }}>保存到草稿</button><button type="button" className="text-xs" onClick={() => setEditing(null)}>取消</button></div></div>}
    </div>;
}
