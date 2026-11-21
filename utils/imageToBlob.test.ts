// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {processImageToBlob} from './file';
const output=new Blob(['compressed'],{type:'image/jpeg'});
let revoke:ReturnType<typeof vi.fn>;let encode:ReturnType<typeof vi.fn>;
beforeEach(() => {
    revoke=vi.fn(); encode=vi.fn((callback:BlobCallback) => callback(output));
    Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(() => 'blob:input')});
    Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke});
    vi.stubGlobal('FileReader',class {constructor(){throw new Error('base64 conversion must not run');}});
    vi.stubGlobal('Image',class {width=1200;height=1600;onload?:()=>void;set src(_value:string){queueMicrotask(() => this.onload?.());}});
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn()} as any);
    vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(encode);
    vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockImplementation(() => {throw new Error('base64 encoding must not run');});
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
it('preserves PNG format and keeps higher-resolution image pixels when compressing to Blob', async () => {
    vi.stubGlobal('Image',class {width=2400;height=3200;onload?:()=>void;set src(_value:string){queueMicrotask(() => this.onload?.());}});
    const file=new File(['original'],'photo.png',{type:'image/png'});
    expect(await processImageToBlob(file,{maxWidth:1600,quality:0.9})).toBe(output);
    const canvas=encode.mock.contexts[0] as HTMLCanvasElement;
    expect([canvas.width,canvas.height]).toEqual([1200,1600]);
    expect(encode).toHaveBeenCalledWith(expect.any(Function),'image/png',0.9);
    expect(revoke).toHaveBeenCalledWith('blob:input');
});
it('keeps original GIF bytes and preserves PNG format when JPEG is not requested', async () => {
    const gif=new File(['GIF89a'],'a.gif',{type:'image/gif'});
    expect(await processImageToBlob(gif)).toBe(gif);expect(URL.createObjectURL).not.toHaveBeenCalled();
    await processImageToBlob(new File(['png'],'a.png',{type:'image/png'}));
    expect(encode).toHaveBeenCalledWith(expect.any(Function),'image/png',0.85);
});
it('releases its URL if decoding or encoding fails', async () => {
    encode.mockImplementation((callback:BlobCallback) => callback(null));
    const file=new File(['broken'],'a.png',{type:'image/png'});
    await expect(processImageToBlob(file)).rejects.toThrow('压缩失败');
    vi.stubGlobal('Image',class {onerror?:()=>void;set src(_value:string){queueMicrotask(() => this.onerror?.());}});
    await expect(processImageToBlob(file)).rejects.toThrow('加载失败');
    expect(revoke).toHaveBeenCalledTimes(2);
});
