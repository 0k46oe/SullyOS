import React, { useEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { importCharacterMedia, openCharacterMediaBackup, type BackupMediaCharacter } from '../../utils/characterMediaBackup';
import Modal from '../os/Modal';

type OpenBackup = Awaited<ReturnType<typeof openCharacterMediaBackup>>;
const button = 'rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50';
const field = 'mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function MediaPreview({ backup, source }: { backup: OpenBackup; source: BackupMediaCharacter }) {
    const [images, setImages] = useState<string[]>([]);
    const [audio, setAudio] = useState<{ index: number; url: string }>();
    const [loadingVoice, setLoadingVoice] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const active = useRef(false);
    const audioUrl = useRef<string>();
    useEffect(() => {
        active.current = true;
        const urls: string[] = [];
        let cancelled = false;
        void (async () => {
            for (const entry of source.photos.filter(photo => photo.media).slice(0, 6)) {
                const photo = await backup.photo(entry).catch(() => null);
                if (cancelled) return;
                if (photo instanceof Blob) {
                    const url = URL.createObjectURL(photo);
                    urls.push(url);
                    setImages(current => [...current, url]);
                }
            }
        })();
        return () => {
            cancelled = true;
            active.current = false;
            urls.forEach(url => URL.revokeObjectURL(url));
            if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
        };
    }, [backup, source]);

    const previewVoice = async (index: number) => {
        setLoadingVoice(true);
        setPreviewError('');
        try {
            const blob = await backup.voice(source.voices[index]);
            if (!active.current) return;
            if (!blob) throw new Error('备份里缺少这条语音的文件');
            if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
            audioUrl.current = URL.createObjectURL(blob);
            setAudio({ index, url: audioUrl.current });
        } catch (error) {
            if (active.current) setPreviewError(message(error));
        } finally {
            if (active.current) setLoadingVoice(false);
        }
    };

    return <>
        {!!images.length && <div className="grid grid-cols-3 gap-2">
            {images.map((url, index) => <img key={url} src={url} alt={`相册预览 ${index + 1}`} className="aspect-square w-full rounded-lg object-cover" />)}
        </div>}
        {source.voices.slice(0, 5).map(({ favorite, media }, index) => <div key={`${favorite.id}-${index}`} className="rounded-xl bg-slate-50 p-2.5">
            <p className="line-clamp-2 text-xs text-slate-600">{favorite.spokenText || favorite.originalText || new Date(favorite.sourceTimestamp).toLocaleString()}</p>
            {media && (audio?.index === index
                ? <audio controls src={audio.url} aria-label="收藏语音试听" className="mt-1 w-full" />
                : <button type="button" disabled={loadingVoice} className="mt-1 text-xs font-semibold text-indigo-700 disabled:opacity-50" onClick={() => void previewVoice(index)}>加载试听</button>)}
        </div>)}
        {previewError && <p role="alert" className="text-xs text-rose-700">{previewError}</p>}
    </>;
}

export default function CharacterMediaRestore() {
    const { characters, sysOperation, addToast } = useOS();
    const input = useRef<HTMLInputElement>(null);
    const archive = useRef<OpenBackup | null>(null);
    const mounted = useRef(false);
    const [open, setOpen] = useState(false);
    const [backup, setBackup] = useState<OpenBackup | null>(null);
    const [sourceKey, setSourceKey] = useState('');
    const [targetId, setTargetId] = useState('');
    const [busy, setBusy] = useState<'read' | 'write' | null>(null);
    const [error, setError] = useState('');
    const source = backup?.characters.find(character => character.key === sourceKey);
    const photos = source?.photos.filter(photo => photo.media).length ?? 0;
    const voices = source?.voices.filter(voice => voice.media).length ?? 0;
    const missing = source ? source.photos.length + source.voices.length - photos - voices : 0;

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const closeArchive = (file: OpenBackup | null) => { void Promise.resolve(file?.close()).catch(() => undefined); };
    // Keep the reader open until an in-flight import finishes, even if Settings unmounts.
    const importing = useRef(false);
    useEffect(() => () => { if (!importing.current) closeArchive(archive.current); }, []);

    const close = () => {
        if (busy) return;
        closeArchive(archive.current);
        archive.current = null;
        setBackup(null);
        setOpen(false);
        setError('');
    };
    useLocalBackHandler(() => { close(); return true; }, 35, open);

    const selectSource = (key: string, file: OpenBackup) => {
        setSourceKey(key);
        const selected = file.characters.find(character => character.key === key);
        setTargetId(characters.some(character => character.id === selected?.id) ? selected!.id : '');
    };

    const read = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = '';
        if (!files.length) return;
        setBusy('read');
        setError('');
        archive.current = null;
        setBackup(null);
        setSourceKey('');
        setTargetId('');
        try {
            const file = await openCharacterMediaBackup(files);
            if (!mounted.current) { closeArchive(file); return; }
            archive.current = file;
            setBackup(file);
            if (file.characters.length === 1) selectSource(file.characters[0].key, file);
        } catch (cause) {
            if (mounted.current) setError(message(cause));
        } finally {
            if (mounted.current) setBusy(null);
        }
    };

    const restore = async () => {
        if (!backup || !source || !targetId || importing.current) return;
        importing.current = true;
        setBusy('write');
        setError('');
        try {
            const result = await importCharacterMedia(backup, source, targetId);
            addToast(`已补入 ${result.photos} 张相册图片和 ${result.voices} 条收藏语音${result.skipped ? `，跳过 ${result.skipped} 项` : ''}`, 'success');
            closeArchive(backup);
            archive.current = null;
            if (mounted.current) { setBackup(null); setOpen(false); }
        } catch (cause) {
            if (mounted.current) setError(message(cause));
        } finally {
            importing.current = false;
            if (mounted.current) setBusy(null);
            else closeArchive(archive.current);
        }
    };

    return <>
        <button type="button" className={`${button} w-full py-3`} disabled={sysOperation.status === 'processing'} onClick={() => setOpen(true)}>按角色补相册和收藏语音</button>
        <Modal isOpen={open} title="按角色补相册和收藏语音" onClose={close} footer={<>
            <button type="button" disabled={!!busy} className={`${button} flex-1`} onClick={close}>关闭</button>
            {source && <button type="button" disabled={!!busy || !targetId || !(photos + voices) || sysOperation.status === 'processing'} onClick={() => void restore()} className="flex-1 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy === 'write' ? '正在合并…' : '确认合并'}</button>}
        </>}>
            <div className="space-y-3">
                <input ref={input} type="file" hidden multiple accept=".zip,.json,.sullypart" onChange={event => void read(event)} />
                {!backup && <button type="button" className={`${button} w-full`} disabled={!!busy} onClick={() => input.current?.click()}>{busy === 'read' ? '正在读取备份…' : '从「文件」选择旧备份'}</button>}
                {!backup && !busy && <p className="text-xs text-slate-500">分卷备份请选择索引和全部分卷。</p>}
                {backup && !backup.characters.length && <p className="text-xs text-slate-600">备份中没有角色相册或收藏语音记录。</p>}
                {!!backup?.characters.length && <label className="block text-xs font-medium text-slate-600">旧备份里的角色
                    <select value={sourceKey} disabled={!!busy} onChange={event => selectSource(event.target.value, backup)} className={field}>
                        <option value="">请选择角色</option>
                        {backup.characters.map(character => <option key={character.key} value={character.key}>{character.space ? `${character.space} · ` : ''}{character.name}（{character.photos.length} 图 · {character.voices.length} 语音）</option>)}
                    </select>
                </label>}
                {source && backup && <>
                    <label className="block text-xs font-medium text-slate-600">合并到当前角色
                        <select value={targetId} disabled={!!busy} onChange={event => setTargetId(event.target.value)} className={field}>
                            <option value="">请选择角色</option>
                            {characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                        </select>
                    </label>
                    <p className="text-xs text-slate-600">可尝试补入 {photos} 张图片、{voices} 条收藏语音。已有可用素材优先保留。{missing ? `备份里缺少 ${missing} 项素材。` : ''}</p>
                    {!!(photos + voices) && busy !== 'write' && <details className="rounded-xl border border-slate-200 p-3">
                        <summary className="cursor-pointer text-xs font-medium text-slate-700">预览部分图片与语音</summary>
                        <div className="mt-2 space-y-2"><MediaPreview key={source.key} backup={backup} source={source} /></div>
                    </details>}
                </>}
                {error && <p role="alert" className="break-words text-xs text-rose-700">{error}</p>}
            </div>
        </Modal>
    </>;
}
