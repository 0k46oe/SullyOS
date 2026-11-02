// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {AVATAR_CROP_CENTER, avatarCropRect, renderAvatarCrop} from './avatarCrop';
import AvatarCropDialog from '../components/user/AvatarCropDialog';
import {useAvatarCrop} from '../hooks/useAvatarCrop';
import {handleLocalBack} from './localBackHandlers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const finish = vi.fn();
const file = () => new File(['image'], 'avatar.png', {type: 'image/png'});
beforeEach(() => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    vi.stubGlobal('URL', Object.assign(URL, {createObjectURL: vi.fn(() => 'blob:avatar-test'), revokeObjectURL: vi.fn()}));
    finish.mockReset();
});
afterEach(() => {act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
const click = async (text: string) => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent === text)!;
    expect(button).toBeTruthy(); await act(async () => button.click());
};
const load = async () => {
    const image = document.querySelector('img')!;
    Object.defineProperties(image, {naturalWidth: {value: 1200}, naturalHeight: {value: 800}});
    await act(async () => image.dispatchEvent(new Event('load')));
    return image;
};

it('centers landscape/portrait crops, clamps edges and limits zoom', () => {
    expect(avatarCropRect(1200, 800, 1, AVATAR_CROP_CENTER)).toMatchObject({x: 200, y: 0, size: 800});
    expect(avatarCropRect(800, 1200, 1, AVATAR_CROP_CENTER)).toMatchObject({x: 0, y: 200, size: 800});
    expect(avatarCropRect(1200, 800, 2, {x: 0, y: 1})).toMatchObject({x: 0, y: 400, size: 400});
    expect(avatarCropRect(800, 800, 20, AVATAR_CROP_CENTER).size).toBe(200);
    expect(() => avatarCropRect(0, 800, 1, AVATAR_CROP_CENTER)).toThrow('图片尺寸无效');
});

it('exports the exact preview source rectangle and preserves transparency at bounded resolution', () => {
    const image = Object.assign(new Image(), {width: 1200, height: 800});
    Object.defineProperties(image, {naturalWidth: {value: 1200}, naturalHeight: {value: 800}});
    const draw = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage: draw} as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function(this: HTMLCanvasElement, type) {
        expect(this.width).toBe(512); expect(this.height).toBe(512); expect(type).toBe('image/png');
        return 'data:image/png;base64,crop';
    });
    expect(renderAvatarCrop(image, 1, AVATAR_CROP_CENTER)).toBe('data:image/png;base64,crop');
    expect(draw).toHaveBeenCalledWith(image, 200, 0, 800, 800, 0, 0, 512, 512);
});

it('loads locally, zooms, resets, and only returns a crop on confirmation', async () => {
    const draw = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage: draw} as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,result');
    await act(async () => root.render(React.createElement(AvatarCropDialog, {file: file(), onComplete: finish})));
    await load(); expect(finish).not.toHaveBeenCalled();
    const slider = document.querySelector('input[type=range]') as HTMLInputElement;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '2'); slider.dispatchEvent(new Event('input', {bubbles: true}));});
    expect(document.querySelector('output')?.textContent).toBe('2.0×');
    await click('重置'); expect(slider.value).toBe('1');
    await click('确认裁剪'); expect(finish).toHaveBeenCalledWith('data:image/png;base64,result');
});

it('cancels through local back without replacing the avatar and releases object URLs', async () => {
    await act(async () => root.render(React.createElement(AvatarCropDialog, {file: file(), onComplete: finish})));
    await act(async () => {expect(handleLocalBack()).toBe(true);});
    expect(finish).toHaveBeenCalledWith(null);
    await act(async () => root.render(null)); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-test');
});

it('keeps the original avatar when canvas export fails and allows cancellation', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await act(async () => root.render(React.createElement(AvatarCropDialog, {file: file(), onComplete: finish})));
    await load(); await click('确认裁剪');
    expect(document.querySelector('[role=alert]')?.textContent).toContain('无法创建裁剪画布');
    expect(finish).not.toHaveBeenCalled();
    await click('取消'); expect(finish).toHaveBeenCalledWith(null);
});

it('warns that GIF cropping is static and preserves original GIF bytes when requested', async () => {
    const gif = new File(['GIF89a'], 'avatar.gif', {type: 'image/gif'});
    await act(async () => root.render(React.createElement(AvatarCropDialog, {file: gif, onComplete: finish})));
    await load(); expect(document.body.textContent).toContain('裁剪后会保存为静态头像');
    await act(async () => {await click('保留原图'); await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('data:image/gif;base64,R0lGODlh'));});
});

it('does not load invalid files and always allows cancel', async () => {
    await act(async () => root.render(React.createElement(AvatarCropDialog, {file: new File(['bad'], 'bad.txt', {type: 'text/plain'}), onComplete: finish})));
    expect(document.querySelector('[role=alert]')?.textContent).toContain('请上传图片');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await click('取消'); expect(finish).toHaveBeenCalledWith(null);
});

it('rejects oversized images before creating a preview URL', async () => {
    const oversized = file(); Object.defineProperty(oversized, 'size', {value: 51 * 1024 * 1024});
    await act(async () => root.render(React.createElement(AvatarCropDialog, {file: oversized, onComplete: finish})));
    expect(document.querySelector('[role=alert]')?.textContent).toContain('50 MB');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('cancels the previous upload when a newer selection replaces it', async () => {
    let choose!: ReturnType<typeof useAvatarCrop>['chooseAvatar'];
    function Upload() {const picker = useAvatarCrop(); choose = picker.chooseAvatar; return picker.avatarCropDialog;}
    await act(async () => root.render(React.createElement(Upload)));
    let previous!: Promise<string | null>, latest!: Promise<string | null>;
    await act(async () => {previous = choose(file());});
    await act(async () => {latest = choose(file());});
    await expect(previous).resolves.toBeNull();
    await click('取消'); await expect(latest).resolves.toBeNull();
});

it('resolves a pending selection as canceled when its upload screen unmounts', async () => {
    let choose!: ReturnType<typeof useAvatarCrop>['chooseAvatar'];
    function Upload() {const picker = useAvatarCrop(); choose = picker.chooseAvatar; return picker.avatarCropDialog;}
    await act(async () => root.render(React.createElement(Upload)));
    let pending!: Promise<string | null>;
    await act(async () => {pending = choose(file());});
    await act(async () => root.render(null));
    await expect(pending).resolves.toBeNull();
});
