import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('memory palace pipeline runtime references', () => {
    const source = readFileSync(path.resolve(__dirname, './pipeline.ts'), 'utf8');

    it('logs the resolved per-character hot-zone value without referencing the removed constant', () => {
        expect(source).not.toMatch(/\bHOT_ZONE_SIZE\b/);
        expect(source).toContain('热区: ${hotZoneSizeForLog}');
    });
});
