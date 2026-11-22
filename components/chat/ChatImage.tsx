import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, DownloadSimple, MagnifyingGlassPlus, MagnifyingGlassMinus } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import { useBlobRefUrl } from '../../utils/blobRef';
import './ChatImage.css';

export function ImageViewer({ value, fallback, name, onClose, items, index = 0, onIndexChange }: { value: string; fallback: string; name?: string; onClose: () => void; items?: string[]; index?: number; onIndexChange?: (index: number) => void }) {
    const [failed, setFailed] = useState(false), [zoom, setZoom] = useState(false);
    const viewerItems = items?.length ? items : [value];
    const canNavigate = viewerItems.length > 1 && !!onIndexChange;
    const currentIndex = Math.max(0, Math.min(index, viewerItems.length - 1));
    const currentValue = viewerItems[currentIndex] || value;
    const displayedValue = failed && currentValue === value ? fallback : currentValue;
    const src = useBlobRefUrl(displayedValue);
    const touchStart = useRef<{ x: number; y: number }>();
    useEffect(() => setFailed(false), [currentValue]);
    const move = (direction: -1 | 1) => {
        if (!canNavigate) return;
        const nextIndex = Math.max(0, Math.min(viewerItems.length - 1, currentIndex + direction));
        if (nextIndex !== currentIndex) {
            setZoom(false);
            onIndexChange!(nextIndex);
        }
    };
    const onTouchStart = (event: React.TouchEvent) => { if (event.touches.length !== 1) { touchStart.current = undefined; return; } const touch = event.touches[0]; if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY }; };
    const onTouchEnd = (event: React.TouchEvent) => {
        const start = touchStart.current, touch = event.changedTouches[0];
        touchStart.current = undefined;
        if (!canNavigate || zoom || !start || !touch) return;
        const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
        if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
        move(dx < 0 ? 1 : -1);
    };
    const close = useRef<HTMLButtonElement>(null);
    useEffect(() => { const previous = document.activeElement as HTMLElement; close.current?.focus(); return () => previous?.focus(); }, []);
    return createPortal(<div className="chat-image-viewer" role="dialog" aria-modal="true" aria-label="图片预览"
        onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onPointerMove={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()} onTouchEnd={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()} onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
            if (e.key === 'Tab') {
                const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button,a[href]'));
                const first = controls[0], last = controls[controls.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        }}>
        <header><button ref={close} onClick={onClose} aria-label="关闭图片预览" title="关闭"><X size={24} /></button>{canNavigate && <span className="chat-image-viewer-count">{currentIndex + 1} / {viewerItems.length}</span>}<div>
            <button onClick={() => setZoom(v => !v)} aria-label={zoom ? '缩小图片' : '放大图片'} title={zoom ? '缩小' : '放大'}>{zoom ? <MagnifyingGlassMinus size={24} /> : <MagnifyingGlassPlus size={24} />}</button>
            {src && <a href={src} download={name || 'photo'} aria-label="保存图片" title="保存图片"><DownloadSimple size={24} /></a>}
        </div></header>
        <div className={`chat-image-stage ${canNavigate ? 'is-navigable' : ''} ${zoom ? 'is-zoomed' : ''}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            {src ? <img src={src} alt={canNavigate ? `第 ${currentIndex + 1} 张图片，共 ${viewerItems.length} 张` : '聊天图片预览'} onError={() => setFailed(true)} /> : <span role="status">正在读取图片…</span>}
        </div>
    </div>, document.body);
}

export default function ChatImage({ value, original, name, selectionMode, eager, onLoad }: { value: string; original?: string; name?: string; selectionMode: boolean; eager?: boolean; onLoad?: () => void }) {
    const [open, setOpen] = useState(false);
    return <><button className="chat-image-thumbnail" type="button" aria-label="查看大图" onClick={e => { if (selectionMode) return; e.stopPropagation(); setOpen(true); }}>
        <TokenImg value={value} className="max-w-[200px] max-h-[300px] rounded-2xl" alt="聊天图片" loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={onLoad} />
    </button>{open && <ImageViewer value={original || value} fallback={value} name={name} onClose={() => setOpen(false)} />}</>;
}
