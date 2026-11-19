import React, {useEffect, useRef} from 'react';
import {applyCssImageUrls, resolveCssImageUrls} from '../../utils/cssImageAssets';
import {appendDevDebugRenderLog, isCaptureEnabled} from '../../utils/devDebug';

/** Keep saved CSS and font rules stable while local images finish loading. */
export default function BlobRefStyle({css, onReady}: {css: string; onReady?: (css: string) => void}) {
    const styleRef = useRef<HTMLStyleElement>(null);
    useEffect(() => {
        const startedAt = performance.now();
        const capture = isCaptureEnabled('render');
        const referenceCount = capture ? (css.match(/blobref:/g) || []).length : 0;
        const svgReferenceCount = capture ? (css.match(/\.svg(?:[?#)"'\s]|$)|data:image\/svg\+xml/gi) || []).length : 0;
        const externalUrlCount = capture ? (css.match(/https?:\/\//gi) || []).length : 0;
        if (!css.includes('blobref:')) {
            appendDevDebugRenderLog('chat-css-ready', {
                referenceCount: 0,
                svgReferenceCount,
                externalUrlCount,
                durationMs: 0,
                outcome: 'inline',
            });
            onReady?.(css);
            return;
        }
        let alive = true; let dispose: (() => void) | undefined;
        void resolveCssImageUrls(css, true).then(result => {
            if (!alive) {result.dispose(); return;}
            dispose = result.dispose;
            try {
                if (styleRef.current?.sheet) applyCssImageUrls(styleRef.current.sheet, result.replacements);
            } catch { /* A stylesheet may have been detached during navigation. */ }
            appendDevDebugRenderLog('chat-css-ready', {
                referenceCount,
                svgReferenceCount,
                externalUrlCount,
                resolvedCount: Array.from(result.replacements.values()).filter(Boolean).length,
                missingCount: Array.from(result.replacements.values()).filter(value => !value).length,
                durationMs: Math.round(performance.now() - startedAt),
                outcome: 'resolved',
            });
            onReady?.(css);
        }).catch(error => {
            if (alive) {
                appendDevDebugRenderLog('chat-css-ready', {
                    referenceCount,
                    svgReferenceCount,
                    externalUrlCount,
                    durationMs: Math.round(performance.now() - startedAt),
                    outcome: 'error',
                    errorName: error instanceof Error ? error.name : 'unknown',
                });
                onReady?.(css);
            }
            /* Ordinary layout CSS remains usable if the asset store is unavailable. */
        });
        return () => {alive = false; dispose?.();};
    }, [css, onReady]);
    return <style ref={styleRef}>{css}</style>;
}
