import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { beautyPreviewDocument, PREVIEW_WIDTH, PREVIEW_HEIGHT } from '../../utils/beautyPreview';

export interface BeautyPreviewHandle { capture: () => Promise<HTMLCanvasElement> }
interface Props { data: unknown }
function copyPaint(element: HTMLElement): HTMLElement {
  const clone = element.cloneNode(false) as HTMLElement;
  const computed = getComputedStyle(element);
  for (const key of Array.from(computed)) clone.style.setProperty(key, computed.getPropertyValue(key));
  // Freeze pseudo-element appearance without copying the author's CSS selectors.
  const pseudo = (name: string) => {
    const css = getComputedStyle(element, name);
    if (!css.content || css.content === 'none' || css.content === 'normal' || css.display === 'none') return;
    const part = document.createElement('span');
    for (const key of Array.from(css)) part.style.setProperty(key, css.getPropertyValue(key));
    if (/^["']/.test(css.content)) part.textContent = css.content.slice(1, -1);
    clone.append(part);
  };
  pseudo('::before');
  for (const node of Array.from(element.childNodes)) {
    if (node instanceof HTMLElement && node.tagName !== 'STYLE') clone.append(copyPaint(node));
    else if (node.nodeType === Node.TEXT_NODE) clone.append(node.cloneNode());
  }
  pseudo('::after'); return clone;
}
export default forwardRef<BeautyPreviewHandle, Props>(function BeautyPresetPreview({ data }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(PREVIEW_WIDTH);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setReady(false); setError('');
    try {
      if (!host.current) return;
      const shadow = host.current.shadowRoot || host.current.attachShadow({ mode: 'open' });
      const parsed = new DOMParser().parseFromString(beautyPreviewDocument(data), 'text/html');
      const style = document.createElement('style');
      // Only text CSS and our own escaped sample markup cross this boundary, never scripts.
      style.textContent = (parsed.querySelector('style')?.textContent || '').replace('html,body{', '.beauty-preview-body{').replace('body{background:', '.beauty-preview-body{background:');
      const body = document.createElement('div'); body.className = 'beauty-preview-body';
      for (const child of Array.from(parsed.body.children)) body.append(child.cloneNode(true));
      shadow.replaceChildren(style, body);
      // Preset :host selectors cannot resize, position or expose the host outside its clip.
      for (const [key, value] of Object.entries({ width: '360px', height: '600px', display: 'block', position: 'relative', overflow: 'hidden', contain: 'strict', 'pointer-events': 'none' })) host.current.style.setProperty(key, value, 'important');
      setReady(true);
    } catch (e) { setError(e instanceof Error ? e.message : '预览失败'); }
  }, [data]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.min(PREVIEW_WIDTH, entries[0].contentRect.width)));
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  useImperativeHandle(ref, () => ({
    capture: async () => {
      const element = host.current;
      if (!ready || !element?.shadowRoot) throw Error('预览尚未加载完成，请稍后再试');
      await document.fonts.ready;
      const { default: html2canvas } = await import('html2canvas');
      const body = element.shadowRoot.querySelector<HTMLElement>('.beauty-preview-body');
      if (!body) throw Error('预览内容尚未就绪');
      const snapshot = copyPaint(body);
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:360px;height:600px;overflow:hidden;pointer-events:none;contain:strict';
      holder.append(snapshot); document.body.append(holder);
      try {
        // html2canvas flattens Shadow DOM into its clone. Exclude all original previews
        // so untrusted selectors cannot see the rest of the app in that temporary clone.
        return await html2canvas(snapshot, { scale: 2, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, backgroundColor: null, useCORS: true, imageTimeout: 8000, logging: false, ignoreElements: node => node.hasAttribute('data-beauty-preview-source') });
      } finally { holder.remove(); }
    },
  }), [ready]);
  return <div className="beauty-preset-preview" ref={container}>
    {error && <p role="alert">{error}</p>}
    <div style={{ height: PREVIEW_HEIGHT * width / PREVIEW_WIDTH, width, margin: 'auto', overflow: 'hidden', borderRadius: 20 }}>
      <div ref={host} data-beauty-preview-source role="img" aria-label="美化预设搭配预览" style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, transform: `scale(${width / PREVIEW_WIDTH})`, transformOrigin: 'top left' }}/>
    </div>
    <p className="beauty-preview-caption">预设搭配预览 · 示例布局和文字，未应用到本机。复杂样式与实际界面可能有差异。</p>
  </div>;
});
