import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import TokenImg from '../os/TokenImg';
import type { Emoji } from '../../types';
import { DB } from '../../utils/db';
import { useOS } from '../../context/OSContext';
import { describeImageWithVisionApi, isVisionApiReady } from '../../utils/visionApi';

/**
 * 表情包的画面描述：开了识图 API 时，角色看到的是这段文字而不是原图。
 * 识图认错了可以在这里手动改或重新识别；清空保存后，下次发送前会自动重新识别。
 */
export default function EmojiDescriptionModal({ emoji, isOpen, onClose, onSaved }: {
    emoji: Emoji | null;
    isOpen: boolean;
    onClose: () => void;
    onSaved: () => void;
}) {
    const { apiConfig, addToast } = useOS();
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const visionReady = isVisionApiReady(apiConfig.visionApi);

    useEffect(() => { if (isOpen) setDraft(emoji?.visionDescription || ''); }, [isOpen, emoji?.name]);

    const recognize = async () => {
        if (!emoji || !apiConfig.visionApi) return;
        setBusy(true);
        try { setDraft(await describeImageWithVisionApi(emoji.url, apiConfig.visionApi)); }
        catch (error: any) { addToast(`识别失败：${error?.message || '未知错误'}`, 'error'); }
        finally { setBusy(false); }
    };

    const save = async () => {
        if (!emoji) return;
        setBusy(true);
        try {
            await DB.setEmojiDescription(emoji.name, draft);
            addToast(draft.trim() ? '画面描述已保存' : '已清空，下次发送前重新识别', 'success');
            onSaved();
            onClose();
        } catch (error: any) {
            addToast(error?.message || '保存失败', 'error');
        } finally { setBusy(false); }
    };

    return <Modal
        isOpen={isOpen} title="表情包画面描述" onClose={onClose}
        footer={<><button onClick={onClose} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button disabled={busy} onClick={save} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl disabled:opacity-40">保存</button></>}
    >
        {emoji && <div className="space-y-3">
            <div className="flex items-center gap-3">
                <TokenImg value={emoji.url} className="w-16 h-16 object-contain rounded-xl border border-slate-200 shrink-0" />
                <p className="text-xs text-slate-400 leading-relaxed">开了识图 API 时，角色看到的是这段描述。认错了可以直接改；清空后保存，下次发送前会重新识别。没开识图时角色直接看原图，用不到这里。</p>
            </div>
            <textarea
                value={draft} onChange={e => setDraft(e.target.value)} rows={5}
                placeholder={visionReady ? '还没有描述，下次发送这张表情包前会自动识别' : '没开识图 API'}
                className="w-full bg-slate-100 rounded-2xl px-4 py-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            {visionReady && <button disabled={busy} onClick={recognize} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 disabled:opacity-40">
                {busy ? '识别中…' : '重新识别（不会自动保存）'}
            </button>}
        </div>}
    </Modal>;
}
