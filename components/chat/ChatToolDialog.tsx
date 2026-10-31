import React, { useEffect, useRef } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

/** Keep tool pages inside the phone, with the same local back behavior on desktop and Android. */
export default function ChatToolDialog({ title, onClose, children, footer }: {
    title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode;
}) {
    const panel = useRef<HTMLDivElement>(null);
    const close = useRef(onClose);
    close.current = onClose;
    const goBack = () => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && panel.current?.contains(active)) active.blur();
        else close.current();
        return true;
    };
    useLocalBackHandler(goBack, 65);
    useEffect(() => {
        const previous = document.activeElement;
        panel.current?.focus({ preventScroll: true });
        return () => { if (previous instanceof HTMLElement && previous.isConnected && !previous.matches('input,textarea')) previous.focus({ preventScroll: true }); };
    }, []);

    return <div ref={panel} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className="absolute inset-0 z-[100] flex min-h-0 flex-col bg-white text-slate-800 outline-none"
        style={{ paddingTop: 'var(--safe-top, 0px)', paddingBottom: 'var(--safe-bottom, 0px)' }}
        onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); goBack(); }
            if (event.key !== 'Tab') return;
            const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') || [])];
            const first = items[0], last = items[items.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); }
        }}>
        <header className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 py-3">
            <button type="button" aria-label={`关闭${title}`} onClick={onClose} className="h-10 w-10 rounded-full text-2xl text-slate-500 hover:bg-slate-100">‹</button>
            <h2 className="min-w-0 flex-1 text-base font-bold">{title}</h2>
        </header>
        {children}
        {footer && <footer className="flex shrink-0 gap-3 border-t border-slate-100 p-4">{footer}</footer>}
    </div>;
}
