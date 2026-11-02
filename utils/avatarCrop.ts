export type AvatarCropPosition = { x: number; y: number };
export const AVATAR_CROP_CENTER: AvatarCropPosition = { x: 0.5, y: 0.5 };

/** Source pixels shared by the on-screen preview and the exported square. */
export function avatarCropRect(width: number, height: number, zoom: number, position: AvatarCropPosition) {
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error('图片尺寸无效');
    const size = Math.min(width, height) / Math.max(1, Math.min(4, Number.isFinite(zoom) ? zoom : 1));
    const x = Math.max(0, Math.min(width - size, width * position.x - size / 2));
    const y = Math.max(0, Math.min(height - size, height * position.y - size / 2));
    return { x, y, size, position: { x: (x + size / 2) / width, y: (y + size / 2) / height } };
}

export function renderAvatarCrop(image: HTMLImageElement, zoom: number, position: AvatarCropPosition): string {
    const crop = avatarCropRect(image.naturalWidth, image.naturalHeight, zoom, position);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.max(1, Math.min(512, Math.round(crop.size)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建裁剪画布，请重试');
    context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
    // Keep transparency; the avatar's existing UI decides its round/square shape.
    const result = canvas.toDataURL('image/png');
    canvas.width = canvas.height = 0;
    if (!result.startsWith('data:image/')) throw new Error('头像裁剪失败');
    return result;
}
