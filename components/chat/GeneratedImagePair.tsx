import React, { useMemo, useState } from 'react';
import TokenImg from '../os/TokenImg';
import { createImageTextCard } from '../../utils/chatImageTextCard';
import { ImageViewer } from './ChatImage';
import './GeneratedImagePair.css';

export default function GeneratedImagePair({ value, prompt, isUser, selectionMode, onLoad }: { value: string; prompt: string; isUser: boolean; selectionMode: boolean; onLoad?: () => void }) {
    const [expanded, setExpanded] = useState(false);
    const [showText, setShowText] = useState(false);
    const [viewerIndex, setViewerIndex] = useState<number>();
    const textImage = useMemo(() => expanded || showText ? createImageTextCard(prompt).toDataURL('image/png') : '', [prompt, expanded, showText]);
    const face = (kind: 'image' | 'text', className: string) => <span className={className}>
        {kind === 'image' ? <TokenImg className="sully-chat-generated-photo" value={value} alt="生成的图片" onLoad={onLoad} /> : textImage ? <img src={textImage} alt="图片画面描述" /> : null}
    </span>;
    const open = (event: React.MouseEvent, index: number) => { if (selectionMode) return; event.stopPropagation(); setViewerIndex(index); };
    return <div className={`sully-chat-generated-pair ${isUser ? 'is-user' : 'is-ai'} ${expanded ? 'is-expanded' : ''}`}>
        <div className="sully-chat-generated-cards">
            {expanded ? <>
                <button type="button" className="sully-chat-generated-card" aria-label="查看生成图片" onClick={e => open(e, 0)}>{face('image', 'sully-chat-generated-face')}</button>
                <button type="button" className="sully-chat-generated-card" aria-label="查看文字描述图" onClick={e => open(e, 1)}>{face('text', 'sully-chat-generated-face')}</button>
            </> : <button type="button" className="sully-chat-generated-stack" aria-label={showText ? '切换到生成图片' : '切换到文字描述图'} onClick={e => { if (selectionMode) return; e.stopPropagation(); setShowText(v => !v); }}>
                {face(showText ? 'image' : 'text', 'sully-chat-generated-face is-back')}
                {face(showText ? 'text' : 'image', 'sully-chat-generated-face is-front')}
            </button>}
        </div>
        <button type="button" className="sully-chat-image-expand sully-chat-generated-expand" aria-expanded={expanded} onClick={e => { if (selectionMode) return; e.stopPropagation(); setExpanded(v => !v); }}>{expanded ? '收起' : '展开'}</button>
        {viewerIndex !== undefined && <ImageViewer value={viewerIndex === 0 ? value : textImage} fallback={viewerIndex === 0 ? value : textImage} items={[value, textImage]} index={viewerIndex} onIndexChange={setViewerIndex} onClose={() => setViewerIndex(undefined)} />}
    </div>;
}
