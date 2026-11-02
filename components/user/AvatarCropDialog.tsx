import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useLocalBackHandler} from '../../hooks/useLocalBackHandler';
import {AVATAR_CROP_CENTER, avatarCropRect, renderAvatarCrop, type AvatarCropPosition} from '../../utils/avatarCrop';
import {processImage} from '../../utils/file';
import './AvatarCropDialog.css';

export default function AvatarCropDialog({file, onComplete}: {file: File; onComplete: (value: string | null) => void}) {
    const [source, setSource] = useState('');
    const [dimensions, setDimensions] = useState({width: 0, height: 0});
    const [zoom, setZoom] = useState(1);
    const [position, setPosition] = useState<AvatarCropPosition>(AVATAR_CROP_CENTER);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const image = useRef<HTMLImageElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const active = useRef(true);
    const saving = useRef(false);
    const drag = useRef<{id: number; x: number; y: number} | null>(null);
    const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
    const cancel = () => {if (!saving.current) onComplete(null);};
    useLocalBackHandler(() => {cancel(); return true;}, 80);
    useEffect(() => {
        active.current = true;
        const previous = document.activeElement as HTMLElement | null;
        dialog.current?.focus();
        if (!file.type.startsWith('image/')) setError('请上传图片文件');
        else if (file.size > 50 * 1024 * 1024) setError('图片过大，请选择 50 MB 以内的图片');
        else {
            const url = URL.createObjectURL(file);
            setSource(url);
            return () => {active.current = false; URL.revokeObjectURL(url); previous?.focus();};
        }
        return () => {active.current = false; previous?.focus();};
    }, [file]);
    const crop = dimensions.width ? avatarCropRect(dimensions.width, dimensions.height, zoom, position) : null;
    const save = async (original = false) => {
        if (saving.current || !crop || !image.current) return;
        saving.current = true; setBusy(true); setError('');
        try {
            const result = original ? await processImage(file) : renderAvatarCrop(image.current, zoom, position);
            if (active.current) onComplete(result);
        } catch (reason) {if (active.current) setError(reason instanceof Error ? reason.message : '图片处理失败');}
        finally {saving.current = false; if (active.current) setBusy(false);}
    };
    const keyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); cancel();}
        if (event.key === 'Tab') {
            const buttons = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || [])];
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {event.preventDefault(); last?.focus();}
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {event.preventDefault(); first?.focus();}
        }
    };
    return createPortal(<div className="avatar-crop-overlay" onKeyDown={keyDown}>
        <div className="avatar-crop-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title">
            <header><h2 id="avatar-crop-title">裁剪头像</h2><button type="button" disabled={busy} onClick={cancel}>取消</button></header>
            <p>拖动图片调整位置，使用滑块放大。圆形辅助线方便预览头像效果。</p>
            <div className="avatar-crop-stage" aria-label="头像裁剪预览" onPointerDown={event => {
                if (!crop || busy || drag.current) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY};
            }} onPointerMove={event => {
                const start = drag.current;
                if (!start || start.id !== event.pointerId || !crop) return;
                const side = event.currentTarget.getBoundingClientRect().width;
                if (!side) return;
                const next = {x: crop.position.x - (event.clientX - start.x) * crop.size / side / dimensions.width, y: crop.position.y - (event.clientY - start.y) * crop.size / side / dimensions.height};
                setPosition(avatarCropRect(dimensions.width, dimensions.height, zoom, next).position);
                drag.current = {id: start.id, x: event.clientX, y: event.clientY};
            }} onPointerUp={() => {drag.current = null;}} onPointerCancel={() => {drag.current = null;}} onLostPointerCapture={() => {drag.current = null;}}>
                {source && <img ref={image} src={source} alt="待裁剪头像" draggable={false} onLoad={event => {
                    const {naturalWidth: width, naturalHeight: height} = event.currentTarget;
                    if (width * height > 40_000_000 || !width || !height) {setError('图片尺寸过大或无效，请先缩小后上传'); return;}
                    setDimensions({width, height});
                }} onError={() => setError('图片无法读取，请换一张图片')} style={crop ? {width: dimensions.width / crop.size * 100 + '%', height: dimensions.height / crop.size * 100 + '%', left: -crop.x / crop.size * 100 + '%', top: -crop.y / crop.size * 100 + '%'} : {visibility: 'hidden'}}/>}
                {crop && <span className="avatar-crop-circle" aria-hidden="true"/>}
                {!crop && !error && <span className="avatar-crop-loading" role="status">正在读取图片…</span>}
            </div>
            <label className="avatar-crop-zoom">缩放 <input aria-label="头像缩放" type="range" min="1" max="4" step="0.01" value={zoom} disabled={!crop || busy} onChange={event => {
                const next = Number(event.target.value);
                setZoom(next); setPosition(avatarCropRect(dimensions.width, dimensions.height, next, position).position);
            }}/><output>{zoom.toFixed(1)}×</output></label>
            {isGif && <p>GIF 裁剪后会保存为静态头像。要保留动画，请选择「保留原图」。</p>}
            {error && <p className="avatar-crop-error" role="alert">{error}</p>}
            <footer>
                <button type="button" disabled={!crop || busy} onClick={() => {setZoom(1); setPosition(AVATAR_CROP_CENTER);}}>重置</button>
                <button type="button" disabled={!crop || busy} onClick={() => void save(true)}>保留原图</button>
                <button type="button" className="avatar-crop-confirm" disabled={!crop || busy} onClick={() => void save()}>{busy ? '处理中…' : '确认裁剪'}</button>
            </footer>
        </div>
    </div>, document.body);
}
