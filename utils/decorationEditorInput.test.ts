// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {useDecorationEditorViewport} from '../hooks/useDecorationEditorViewport';
import {usePreviewDraft} from '../hooks/usePreviewDraft';
import CssCodeEditor from '../components/chat/CssCodeEditor';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

it('follows keyboard height and panning and scrolls the focused extra CSS field', async () => {
 const viewport=Object.assign(new EventTarget(),{scale:1,offsetTop:0,height:800});
 vi.stubGlobal('visualViewport',viewport);
 function Editor(){const {ref,editingCss}=useDecorationEditorViewport();return React.createElement('div',{ref,'data-editing':editingCss},React.createElement('aside',{className:'decoration-composer-controls'},React.createElement('textarea',{'aria-label':'追加 CSS'})));}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try {
  await act(async()=>root.render(React.createElement(Editor)));
  const page=host.firstElementChild as HTMLElement,scroll=page.querySelector('aside')!,input=page.querySelector('textarea')!;
  vi.spyOn(scroll,'getBoundingClientRect').mockReturnValue({top:90,bottom:390,height:300} as DOMRect);
  vi.spyOn(input,'getBoundingClientRect').mockReturnValue({top:420,bottom:560,height:140} as DOMRect);
  await act(async()=>{input.focus();viewport.height=340;viewport.offsetTop=50;viewport.dispatchEvent(new Event('resize'));await new Promise(resolve=>requestAnimationFrame(resolve));});
  expect(page.style.height).toBe('340px');expect(page.style.top).toBe('50px');expect(page.dataset.editing).toBe('true');expect(scroll.scrollTop).toBe(178);
  await act(async()=>input.blur());expect(page.dataset.editing).toBe('false');
  viewport.height=800;viewport.offsetTop=0;await act(async()=>viewport.dispatchEvent(new Event('resize')));expect(page.style.height).toBe('800px');
 }finally{act(()=>root.unmount());host.remove();}
});

it('keeps long CSS out of the preview while typing and flushes the latest draft after blur', async()=>{
 vi.useFakeTimers();
 function Preview({value,paused}:{value:string;paused:boolean}){return React.createElement('output',null,usePreviewDraft(value,true,paused));}
 const host=document.createElement('div'),root=createRoot(host);
 try{
  await act(async()=>root.render(React.createElement(Preview,{value:'initial',paused:false})));
  await act(async()=>root.render(React.createElement(Preview,{value:'edited first',paused:true})));
  await act(async()=>vi.advanceTimersByTime(2000));expect(host.textContent).toBe('initial');
  await act(async()=>root.render(React.createElement(Preview,{value:'latest',paused:true})));
  await act(async()=>root.render(React.createElement(Preview,{value:'latest',paused:false})));
  await act(async()=>vi.advanceTimersByTime(300));expect(host.textContent).toBe('latest');
 }finally{act(()=>root.unmount());}
});

it('edits embedded image CSS as short text without losing image data',async()=>{
 const css='.sully-chat-root{background:url(data:image/png;base64,'+'A'.repeat(2000000)+');color:red}';
 const change=vi.fn(),host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(React.createElement(CssCodeEditor,{value:css,onChange:change})));
  const input=host.querySelector('textarea')!;expect(input.value.length).toBeLessThan(150);
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,input.value.replace('red','blue'));input.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(change).toHaveBeenCalledWith(css.replace('red','blue'));
 }finally{act(()=>root.unmount());host.remove();}
});
