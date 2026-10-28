import React, { useId, useState } from 'react';
import type { DialogueApiConfig } from '../../types';

export default function DialogueApiFields({ value, onChange, fetchModels, isLoadingModels, openModelPicker }: {
 value: DialogueApiConfig; onChange: (patch: Partial<DialogueApiConfig>) => void;
 fetchModels: () => void; isLoadingModels: boolean; openModelPicker: () => void;
}) {
 const { baseUrl: localUrl, apiKey: localKey, model: localModel, stream: localStream = false, temperature: localTemperature = 0.85 } = value;
 const [showApiAdvanced, setShowApiAdvanced] = useState(false);
 const protocolId = useId();
 const displayStream = localStream;
 const nativeCustomTemperature = value.anthropicCustomTemperature === true;
 const promptCacheTtl = value.anthropicPromptCacheTtl === '1h' ? '1h' : '5m';
 const nativeTemperature = Math.min(1, Math.max(0, Number.isFinite(localTemperature) ? localTemperature : 0.85));
 const setLocalUrl = (baseUrl: string) => onChange({ baseUrl });
 const setLocalKey = (apiKey: string) => onChange({ apiKey });
 const setLocalTemperature = (temperature: number) => onChange({ temperature });
 return <div className="space-y-4">
                <div className="group">
                    <label htmlFor={protocolId} className="text-[10px] font-bold text-slate-400 block mb-1.5 pl-1">接口格式</label>
                    <select id={protocolId} value={value.protocol || 'openai'} onChange={e => onChange({ protocol: e.target.value as 'openai' | 'anthropic', ...(e.target.value === 'anthropic' ? { temperature: nativeTemperature } : {}) })}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm">
                        <option value="openai">OpenAI 兼容</option>
                        <option value="anthropic">Anthropic 原生（Messages）</option>
                    </select>
                    {value.protocol === 'anthropic' && <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">用于普通私聊，可在下方选择流式或非流式，也可使用模型默认或自定义温度。支持视觉的模型可直接接收图片，无需配置独立识图；已开启独立识图时仍先转成文字。地址可填服务根地址、/v1 或完整 /v1/messages；接口需允许浏览器跨域访问。云端即时聊天、其他 App 和专用 API 暂未适配。</p>}
                </div>
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                    <input type="text" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} placeholder="https://..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                    <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="sk-..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                {/* Anthropic streaming is a normal chat option, visible without expanding advanced settings. */}
                {value.protocol === 'anthropic' && <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/60 bg-white/40 px-3 py-3">
                    <div><span className="text-xs text-slate-500">流式输出</span><p className="mt-1 text-[10px] leading-relaxed text-slate-400">开启后逐步显示回复；关闭后等待完整回复。</p></div>
                    <button type="button" role="switch" aria-label="流式输出" aria-checked={displayStream} onClick={() => onChange({ stream: !localStream })}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${displayStream ? 'bg-slate-400' : 'bg-slate-200'}`}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${displayStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                </div>}
                {value.protocol === 'anthropic' && <div className="rounded-xl border border-slate-200/60 bg-white/40 px-3 py-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <div><span className="text-xs text-slate-500">自定义温度</span><p className="mt-1 text-[10px] leading-relaxed text-slate-400">{nativeCustomTemperature ? `当前发送：${nativeTemperature.toFixed(2)}` : '模型默认 · 不发送温度参数'}</p></div>
                        <button type="button" role="switch" aria-label="Anthropic 自定义温度" aria-checked={nativeCustomTemperature}
                            onClick={() => onChange({ anthropicCustomTemperature: !nativeCustomTemperature, ...(!nativeCustomTemperature ? { temperature: nativeTemperature } : {}) })}
                            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${nativeCustomTemperature ? 'bg-slate-400' : 'bg-slate-200'}`}>
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${nativeCustomTemperature ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                    </div>
                    <input aria-label="Anthropic 温度" type="range" min="0" max="1" step="0.01" disabled={!nativeCustomTemperature} value={nativeTemperature}
                        onChange={event => onChange({ temperature: Number(event.target.value) })} className="block w-full accent-slate-500 disabled:opacity-35" />
                    <p className="text-[10px] leading-relaxed text-slate-400">范围 0～1。部分模型不接受温度参数，如接口报错可关闭此项改用模型默认；不会自动重发请求。</p>
                </div>}
                {value.protocol === 'anthropic' && <div className="rounded-xl border border-slate-200/60 bg-white/40 px-3 py-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <div><span className="text-xs text-slate-500">提示词缓存</span><p className="mt-1 text-[10px] leading-relaxed text-slate-400">缓存稳定的角色设定前缀，默认开启。</p></div>
                        <button type="button" role="switch" aria-label="Anthropic 提示词缓存" aria-checked={value.anthropicPromptCache !== false}
                            onClick={() => onChange({ anthropicPromptCache: value.anthropicPromptCache === false })}
                            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${value.anthropicPromptCache !== false ? 'bg-slate-400' : 'bg-slate-200'}`}>
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${value.anthropicPromptCache !== false ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                    </div>
                    <p className="text-[10px] leading-relaxed text-slate-400">首次通常写入缓存；相同前缀在有效期内再次请求才可能命中，还需达到模型的最小长度且中转支持。调用记录显示服务返回的缓存读写量；不支持缓存标记的接口可关闭此项。</p>
                    <label className="flex items-center justify-between gap-3 text-[10px] text-slate-500">缓存有效期
                        <select aria-label="Anthropic 缓存有效期" value={promptCacheTtl} disabled={value.anthropicPromptCache === false}
                            onChange={event => onChange({ anthropicPromptCacheTtl: event.target.value as '5m' | '1h' })}
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 disabled:opacity-40">
                            <option value="5m">5 分钟</option><option value="1h">1 小时</option>
                        </select>
                    </label>
                    <p className="text-[10px] leading-relaxed text-slate-400">思考沿用角色的「心象／思维链」开关，只显示接口实际返回的思考内容或摘要。启用原生思考时不发送自定义温度；模型名（含前后缀）完整保留。</p>
                </div>}
                {/* Advanced sampling options stay collapsed by default. */}
                <div className="pt-1">
                    <button
                        type="button"
                        onClick={() => setShowApiAdvanced(v => !v)}
                        className="text-[10px] text-slate-300 hover:text-slate-400 transition-colors flex items-center gap-1 pl-1 active:scale-95"
                    >
                        <span>高级（不建议修改）</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-2.5 h-2.5 transition-transform ${showApiAdvanced ? 'rotate-180' : ''}`}>
                            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                        </svg>
                    </button>
                    {showApiAdvanced && (
                        <div className="mt-2 pl-2 border-l-2 border-slate-100 space-y-3 py-2">
                            <p className="text-[10px] text-slate-300 leading-relaxed">
                                {value.protocol === 'anthropic' ? '流式与自定义温度在上方单独设置。' : '这两项绝大多数用户保持默认即可。除非接口报错"only stream supported"或对回复风格有强需求，否则不建议改。'}
                            </p>
                            {value.protocol !== 'anthropic' && <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-[10px] text-slate-400">流式输出 (Stream)</span>
                                    <p className="text-[9px] text-slate-300 mt-0.5">仅在你的 API 强制要求时打开</p>
                                </div>
                                <button
                                    type="button"
                                    role="switch" aria-label="流式输出" aria-checked={displayStream}
                                    onClick={() => onChange({ stream: !localStream })}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${displayStream ? 'bg-slate-400' : 'bg-slate-200'}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${displayStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                            </div>}
                            {value.protocol !== 'anthropic' && <div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-slate-400">温度 (Temperature)</span>
                                    <span className="text-[10px] font-mono text-slate-400">{localTemperature.toFixed(2)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="2"
                                    step="0.05"
                                    value={localTemperature}
                                    onChange={(e) => setLocalTemperature(parseFloat(e.target.value))}
                                    className="w-full accent-slate-400 mt-1"
                                />
                                <p className="text-[9px] text-slate-300 mt-0.5">默认 0.85；用于支持此配置的角色回复</p>
                            </div>}
                        </div>
                    )}
                </div>

                <div className="pt-2">
                     <div className="flex justify-between items-center mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                        <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">{isLoadingModels ? '正在拉取…' : '刷新模型列表'}</button>
                    </div>
                    
                    <button
                        onClick={openModelPicker}
                        title={localModel || '选择模型…'}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm"
                    >
                        <span
                            className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left"
                            style={{ direction: 'rtl', textOverflow: 'ellipsis' }}
                        >
                            <bdi style={{ direction: 'ltr' }}>{localModel || '选择模型…'}</bdi>
                        </span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 flex-shrink-0"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                    </button>
                </div>


 </div>;
}
