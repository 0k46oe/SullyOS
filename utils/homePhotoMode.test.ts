// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import HomePhotoMode from '../apps/room3d/HomePhotoMode';
vi.mock('../apps/room3d/PhotoActions',()=>({PhotoActions:()=>null}));
vi.mock('../apps/room3d/PhotoFilterPresets',()=>({default:()=>null}));
vi.mock('../utils/shareExport',()=>({shareOrDownloadBlob:vi.fn()}));
vi.mock('@phosphor-icons/react',()=>({Camera:()=>null,X:()=>null,DownloadSimple:()=>null,ArrowCounterClockwise:()=>null}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const host=document.createElement('div');document.body.append(host);let root:ReturnType<typeof createRoot>;
beforeEach(()=>{
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(390);vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(844);
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>setTimeout(()=>fn(0),0));vi.stubGlobal('cancelAnimationFrame',clearTimeout);
 vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn(()=>'blob:photo'),revokeObjectURL:vi.fn()}));
 HTMLCanvasElement.prototype.setPointerCapture=vi.fn();
 vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(cb=>cb(new Blob(['png'],{type:'image/png'})));
 root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();});
async function setup(){const editor={beginPhotoMode:vi.fn(()=>[]),endPhotoMode:vi.fn(),setPhotoCamera:vi.fn(),renderPhoto:vi.fn(),subscribePhoto:vi.fn(()=>()=>{})};const close=vi.fn();await act(async()=>{root.render(React.createElement(HomePhotoMode,{editor:editor as any,onClose:close}));});await act(async()=>{await new Promise(r=>setTimeout(r,10));});return {editor,close};}
async function click(label:string){const button=[...host.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent)===label)!;expect(button).toBeTruthy();await act(async()=>button.click());}
it('defaults to true landscape and exports a separate high-resolution canvas with the chosen aspect',async()=>{
 const {editor}=await setup();expect(editor.renderPhoto.mock.calls.at(-1)?.[2]).toMatchObject({aspect:16/9,quality:'preview'});
 await click('镜头');await click('电影 2.39:1');await click('拍下合影');
 const call=editor.renderPhoto.mock.calls.find(c=>c[2]?.quality==='export')!;expect(call[2].aspect).toBe(2.39);expect(call[0]).not.toBe(host.querySelector('.photo-view'));expect(host.querySelector('img[alt="拍好的合影"]')).toBeTruthy();
});
it('maps sideways drags into camera coordinates and leaves the shared application unrotated',async()=>{
 const {editor}=await setup();await click('横屏取景');expect(host.querySelector('.home-photo-mode')?.getAttribute('data-sideways')).toBe('true');expect(host.style.transform).toBe('');
 const canvas=host.querySelector('canvas')!;const send=(type:string,x:number,y:number)=>canvas.dispatchEvent(Object.assign(new MouseEvent(type,{bubbles:true,clientX:x,clientY:y}),{pointerId:1}));
 act(()=>{send('pointerdown',50,50);send('pointermove',50,90);send('pointerup',50,90);});
 expect(editor.setPhotoCamera).toHaveBeenLastCalledWith(expect.objectContaining({yaw:-14,pitch:4}));await click('回到竖屏');expect(host.querySelector('.home-photo-mode')?.getAttribute('data-sideways')).toBe('false');
});
it('requests real negative space through camera pan and preserves the existing exit path',async()=>{
 const {editor,close}=await setup();await click('镜头');await click('左侧留白');expect(editor.setPhotoCamera).toHaveBeenLastCalledWith(expect.objectContaining({pan:-2,zoom:.78}));await click('退出拍照');expect(close).toHaveBeenCalledOnce();
});
