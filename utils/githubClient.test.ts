import { describe, expect, it } from 'vitest';

import { readResponseArrayBuffer } from './githubClient';

describe('readResponseArrayBuffer', () => {
    it('reports streamed byte progress while preserving the payload', async () => {
        const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
        const progress: number[] = [];
        const result = await readResponseArrayBuffer(new Response(source), value => progress.push(value));

        expect(Array.from(new Uint8Array(result))).toEqual(Array.from(source));
        expect(progress.length).toBeGreaterThan(0);
        expect(progress.at(-1)).toBe(source.byteLength);
    });
});
