import React, { useCallback, useEffect, useState } from 'react';
import { savePendingAutomaticImage } from '../../utils/chatImageLibrary';

/** Pending is persisted with the message, so mounting the chat also resumes interrupted saves. */
export default function GeneratedImageSaveStatus({ messageId }: { messageId: number }) {
    const [status, setStatus] = useState<'saving' | 'saved' | 'failed' | 'hidden'>('saving');
    const save = useCallback(async () => {
        setStatus('saving');
        try {
            const result = await savePendingAutomaticImage(messageId);
            setStatus(result === 'saved' ? 'saved' : 'hidden');
        } catch { setStatus('failed'); }
    }, [messageId]);
    useEffect(() => { void save(); }, [save]);
    useEffect(() => {
        if (status !== 'saved') return;
        const timer = window.setTimeout(() => setStatus('hidden'), 4000);
        return () => window.clearTimeout(timer);
    }, [status]);
    if (status === 'hidden') return null;
    if (status === 'failed') return <button type="button" className="sully-chat-image-save-status is-failed" onClick={e => { e.stopPropagation(); void save(); }}>保存失败，点击重试</button>;
    return <div className="sully-chat-image-save-status" role="status">{status === 'saving' ? '正在保存到图库…' : '已保存到图库'}</div>;
}
