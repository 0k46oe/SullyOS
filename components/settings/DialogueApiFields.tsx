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
 const setLocalUrl = (baseUrl: string) => onChange({ baseUrl });
 const setLocalKey = (apiKey: string) => onChange({ apiKey });
 const setLocalTemperature = (temperature: number) => onChange({ temperature });
 return <div className="space-y-4">
                <div className="group">
                    <label htmlFor={protocolId} className="text-[10px] font-bold text-slate-400 block mb-1.5 pl-1">接口格式</label>
                    <select id={protocolId} value={value.protocol || 'openai'} onChange={e => onChange({ protocol: e.target.value as 'openai' | 'anthropic' })}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm">
                        <option value="openai">OpenAI 兼容</option>
                        <option value="anthropic">Anthropic 原生（Messages）</option>
                    </select>
                    {value.protocol === 'anthropic' && <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">用于普通私聊，可在下方选择流式或非流式，使用模型默认温度。支持视觉的模型可直接接收图片，无需配置独立识图；已开启独立识图时仍先转成文字。地址可填服务根地址、/v1 或完整 /v1/messages；接口需允许浏览器跨域访问。云端即时聊天、其他 App 和专用 API 暂未适配。</p>}
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
                                {value.protocol === 'anthropic' ? 'Anthropic 使用模型默认温度；流式开关在上方单独设置。' : '这两项绝大多数用户保持默认即可。除非接口报错"only stream supported"或对回复风格有强需求，否则不建议改。'}
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
                            <div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-slate-400">温度 (Temperature)</span>
                                    <span className="text-[10px] font-mono text-slate-400">{localTemperature.toFixed(2)}</span>
                                </div>
                                <input
                                    type="range"
                                    disabled={value.protocol === 'anthropic'}
                                    min="0"
                                    max="2"
                                    step="0.05"
                                    value={localTemperature}
                                    onChange={(e) => setLocalTemperature(parseFloat(e.target.value))}
                                    className="w-full accent-slate-400 mt-1"
                                />
                                <p className="text-[9px] text-slate-300 mt-0.5">默认 0.85；用于支持此配置的角色回复</p>
                            </div>
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
