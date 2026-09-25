import React, { useEffect, useState } from 'react';
import type { BeautyKind } from '../../utils/beautyShareContract';
import { normalizeBeautyPackage, readBeautyPackage } from '../../utils/beautyShareClient';
import BeautyPresetPreview from './BeautyPresetPreview';
import type { BeautySource } from './BeautySharePanel';

interface Props { sources: BeautySource[]; source: string; file: File | null; kind: BeautyKind; onSource: (id: string) => void; onFile: (file: File | null) => void }
export default function BeautyPresetPicker({ sources, source, file, kind, onSource, onFile }: Props) {
  const [pack, setPack] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const selected = sources.find(s => s.id === source);
  // A stable selection key avoids re-exporting 20 MB on every metadata keystroke.
  useEffect(() => {
    let alive = true; setPack(null); setError('');
    if (source === 'file' && !file || source !== 'file' && !selected) { setLoading(false); return; }
    setLoading(true);
    const load = source === 'file' ? readBeautyPackage(file!, kind) : selected!.read();
    load.then(value => { if (alive) setPack(normalizeBeautyPackage(value, kind)); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : '预览读取失败'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [source, file, kind, selected?.read]);
  return <section>
    <label>选择已保存的预设<select value={source} onChange={e => onSource(e.target.value)}><option value="file">上传预设文件</option>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    {source === 'file' && <label>预设文件（JSON / ZIP / PNG）<input type="file" accept=".json,.zip,.png" onChange={e => onFile(e.target.files?.[0] || null)}/></label>}
    {loading && <p role="status">正在载入预设预览…</p>}{error && <p role="alert">{error}</p>}{!!pack && <BeautyPresetPreview data={pack}/>}
  </section>;
}
