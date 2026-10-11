// @vitest-environment jsdom
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {StoryTheaterEntry} from '../types';
import StoryArchivePanel from '../components/date/story/StoryArchivePanel';
import {convertStoryArchiveToMemory} from './storyTheaterMemoryConversion';
import {shareOrDownloadFile} from './shareExport';
vi.mock('../context/OSContext',()=>({useOS:()=>({characters:[{id:'a',name:'阿泽',memoryPalaceEnabled:true},{id:'b',name:'小北',memoryPalaceEnabled:false}],userProfile:{name:'用户'},apiConfig:{baseUrl:'mock',model:'test'},memoryPalaceConfig:{lightLLM:{baseUrl:'mock',model:'test'},embedding:{}},addToast:vi.fn()})}));
vi.mock('../components/date/story/StoryTheaterTheme',()=>({StoryAppearanceButton:()=>null}));
vi.mock('./storyTheaterMemoryConversion',async original=>({...await original<any>(),convertStoryArchiveToMemory:vi.fn()}));
vi.mock('./shareExport',()=>({shareOrDownloadFile:vi.fn().mockResolvedValue('downloaded')}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:ReturnType<typeof createRoot>,host:HTMLDivElement,entry:StoryTheaterEntry;
beforeEach(()=>{
 vi.clearAllMocks();entry={id:'story',title:'车站',characterIds:['a','b'],mask:{type:'user'},archives:[{id:'one',strategy:'summary',summary:'雨夜等待的完整摘要。',fromMessageId:1,toMessageId:5,messageCount:5,createdAt:1},{id:'two',strategy:'summary',summary:'第二幕一起回家。',fromMessageId:6,toMessageId:9,messageCount:4,createdAt:2}]} as StoryTheaterEntry;
 host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();});
const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent?.includes(text))!;
const fill=(label:string,value:string)=>act(()=>{const input=host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
function mount(){function App(){const [value,setValue]=useState(entry);return React.createElement(StoryArchivePanel,{entry:value,masks:[],onUpdated:setValue,onBack:()=>{}});}act(()=>root.render(React.createElement(App)));}
it('requires selecting a box and supplying a date before conversion; exports only checked summaries',async()=>{
 mount();expect(button('一键转为记忆').disabled).toBe(true);expect(host.textContent).toContain('雨夜等待的完整摘要');
 act(()=>host.querySelector<HTMLInputElement>('[aria-label="选择事件盒 1"]')!.click());
 expect(button('一键转为记忆').disabled).toBe(true);expect(convertStoryArchiveToMemory).not.toHaveBeenCalled();
 await act(async()=>button('导出选中').click());
 expect(vi.mocked(shareOrDownloadFile).mock.calls[0][0].content).toContain('雨夜等待');expect(vi.mocked(shareOrDownloadFile).mock.calls[0][0].content).not.toContain('第二幕');
 fill('事件盒 1 记忆日期','2026-09-01');expect(button('一键转为记忆').disabled).toBe(false);
});
it('retains failed selections and completed receipts so retry does not re-convert completed boxes',async()=>{
 vi.mocked(convertStoryArchiveToMemory).mockImplementation(async options=>{
  if(options.archiveId==='two')throw new Error('模型暂时不可用');
  const receipt={date:options.date,convertedAt:4,destination:'palace' as const,memoryIds:['n1'],skipped:0};
  return {entry:{...entry,archives:entry.archives.map(b=>b.id==='one'?{...b,memoryConversions:{a:receipt}}:b)},receipt,alreadyConverted:false};
 });
 mount();act(()=>button('全选').click());fill('事件盒 1 记忆日期','2026-09-01');fill('事件盒 2 记忆日期','2026-09-02');
 await act(async()=>button('一键转为记忆').click());
 expect(host.textContent).toContain('已转化给 阿泽');expect(host.querySelector('[role="alert"]')!.textContent).toContain('已完成 1 个');
 expect(host.querySelector<HTMLInputElement>('[aria-label="选择事件盒 1"]')!.checked).toBe(false);expect(host.querySelector<HTMLInputElement>('[aria-label="选择事件盒 2"]')!.checked).toBe(true);
 await act(async()=>button('一键转为记忆').click());expect(vi.mocked(convertStoryArchiveToMemory).mock.calls.map(([o])=>o.archiveId)).toEqual(['one','two','two']);
});
