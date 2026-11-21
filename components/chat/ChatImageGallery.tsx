import React, { useState } from 'react';
import TokenImg from '../os/TokenImg';
import { ImageViewer } from './ChatImage';
import './ChatImageGallery.css';

export default function ChatImageGallery({ values, isUser, selectionMode, onLoad }: { values: string[]; isUser: boolean; selectionMode: boolean; onLoad?: () => void }) {
    const [expanded, setExpanded] = useState(false);
    const [viewer, setViewer] = useState<string>();
    const images = values.filter(Boolean);
    if (images.length < 2) return null;
    return <div className={`sully-chat-image-gallery ${isUser ? 'is-user' : 'is-ai'}`}>
        <div className={`sully-chat-image-gallery-stack ${expanded ? 'is-expanded' : ''}`}>
            {expanded ? images.map((value, index) => <button type="button" className="sully-chat-image-gallery-card" key={`${index}:${value}`} aria-label={`查看第 ${index + 1} 张图片`} onClick={event => { if (selectionMode) return; event.stopPropagation(); setViewer(value); }}><TokenImg value={value} alt={`聊天图片 ${index + 1}`} onLoad={onLoad} /></button>) : <button type="button" className="sully-chat-image-gallery-cover" aria-label={`展开 ${images.length} 张图片`} onClick={event => { if (selectionMode) return; event.stopPropagation(); setExpanded(true); }}>
                {images.slice(0, 3).map((value, index) => <span key={`${index}:${value}`} className={`sully-chat-image-gallery-layer layer-${index}`}><TokenImg value={value} alt="" onLoad={onLoad} /></span>)}
            </button>}
        </div>
        <button type="button" className="sully-chat-image-expand" aria-expanded={expanded} onClick={event => { if (selectionMode) return; event.stopPropagation(); setExpanded(value => !value); }}>{expanded ? '收起' : `展开 · ${images.length} 张图片`}</button>
        {viewer && <ImageViewer value={viewer} fallback={viewer} onClose={() => setViewer(undefined)} />}
    </div>;
}
