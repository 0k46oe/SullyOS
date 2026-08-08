import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('../hooks/useChatAI.ts', import.meta.url)), 'utf8');
const emotionFunction = source.slice(
    source.indexOf('export async function evaluateEmotionBackground'),
    source.indexOf('\ninterface UseChatAIProps'),
);

describe('emotion evaluation background lease wiring', () => {
    it('holds its own KeepAlive lease until evaluation and persistence finish', () => {
        const startAt = emotionFunction.indexOf('await KeepAlive.start()');
        const requestAt = emotionFunction.indexOf('await safeFetchJson');
        const stopAt = emotionFunction.lastIndexOf('KeepAlive.stop()');
        const emotionEndAt = emotionFunction.lastIndexOf('CHAT_GEN_EVENTS.emotionEnd');

        expect(startAt).toBeGreaterThan(0);
        expect(requestAt).toBeGreaterThan(startAt);
        expect(stopAt).toBeGreaterThan(requestAt);
        expect(emotionEndAt).toBeGreaterThan(stopAt);
        expect(emotionFunction).toContain('if (keepAliveHeld) KeepAlive.stop()');
    });
});
