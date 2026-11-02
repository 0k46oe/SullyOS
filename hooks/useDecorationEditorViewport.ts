import {useEffect, useRef, useState} from 'react';

/** Keep the body portal inside the keyboard's visible viewport, without moving the app shell. */
export function useDecorationEditorViewport() {
    const ref = useRef<HTMLDivElement>(null);
    const [editingCss, setEditingCss] = useState(false);
    useEffect(() => {
        const page = ref.current;
        if (!page) return;
        const viewport = window.visualViewport;
        let frame = 0;
        const sync = () => {
            if (viewport && viewport.scale !== 1) return;
            page.style.top = `${viewport?.offsetTop || 0}px`;
            page.style.height = `${viewport?.height || window.innerHeight}px`;
            const active = document.activeElement;
            setEditingCss(active instanceof HTMLTextAreaElement && page.contains(active));
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const field = document.activeElement;
                if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) || !page.contains(field)) return;
                const scroll = field.closest<HTMLElement>('.decoration-composer-controls, .decoration-shelf-results');
                if (!scroll) return;
                const area = scroll.getBoundingClientRect(), rect = field.getBoundingClientRect();
                if (rect.top < area.top || rect.height > area.height) scroll.scrollTop += rect.top - area.top - 8;
                else if (rect.bottom > area.bottom) scroll.scrollTop += rect.bottom - area.bottom + 8;
            });
        };
        sync();
        viewport?.addEventListener('resize', sync);
        viewport?.addEventListener('scroll', sync);
        window.addEventListener('resize', sync);
        page.addEventListener('focusin', sync);
        page.addEventListener('focusout', sync);
        return () => {
            cancelAnimationFrame(frame);
            viewport?.removeEventListener('resize', sync);
            viewport?.removeEventListener('scroll', sync);
            window.removeEventListener('resize', sync);
            page.removeEventListener('focusin', sync);
            page.removeEventListener('focusout', sync);
        };
    }, []);
    return {ref, editingCss};
}
