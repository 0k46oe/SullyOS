// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageTextCard } from './chatImageTextCard';

describe('image description card', () => {
    afterEach(() => vi.restoreAllMocks());
    it('renders the full description on a white 1024×1536 canvas', () => {
        const fillText = vi.fn(), fillRect = vi.fn();
        const context = { fillText, fillRect, measureText: (text: string) => ({ width: text.length * 30 }), font: '', fillStyle: '', textAlign: '', textBaseline: '' };
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as any);
        const canvas = createImageTextCard('窗边\n手部特写');
        expect([canvas.width, canvas.height]).toEqual([1024, 1536]);
        expect(fillRect).toHaveBeenCalledWith(0, 0, 1024, 1536);
        expect(fillText.mock.calls.map(call => call[0])).toEqual(['窗边', '手部特写']);
    });
});
