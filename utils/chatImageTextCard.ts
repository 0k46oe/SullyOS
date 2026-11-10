import { putImageBlob } from './blobRef';

/** Render the same 1024×1536 text card for successful and failed image requests. */
export function createImageTextCard(prompt: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1536;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建文字描述图');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const text = prompt.trim();
    let lines: string[] = []; let size = 48;
    for (; size >= 8; size -= 2) {
        ctx.font = `${size}px sans-serif`; lines = [];
        for (const paragraph of text.split('\n')) {
            let line = '';
            for (const ch of Array.from(paragraph)) {
                if (line && ctx.measureText(line + ch).width > 824) { lines.push(line); line = ''; }
                line += ch;
            }
            lines.push(line);
        }
        if (lines.length * size * 1.55 <= 1336) break;
    }
    const lineHeight = size * 1.55;
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const top = (canvas.height - lines.length * lineHeight) / 2 + lineHeight / 2;
    lines.forEach((line, index) => ctx.fillText(line, canvas.width / 2, top + index * lineHeight));
    return canvas;
}

export async function saveImageTextCard(prompt: string): Promise<string> {
    const canvas = createImageTextCard(prompt);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('文字描述图保存失败');
    return putImageBlob(blob);
}
