import { describe, expect, it } from 'vitest';
import { enterQixiInterlayerState, selectQixiWordTurn } from './qixiSessionState';

describe('enterQixiInterlayerState', () => {
    it('keeps background-generated Part 2 and Part 3 results when room 01 starts', () => {
        const bridge = { id: 'part-2-result' };
        const reunion = { id: 'part-3-result' };
        const current = {
            stage: 'entry',
            sceneIndex: 0,
            bridge,
            reunion,
            bridgePlaced: [],
        };

        const next = enterQixiInterlayerState(current, 'explore');

        expect(next.stage).toBe('scene');
        expect(next.attitude).toBe('explore');
        expect(next.bridge).toBe(bridge);
        expect(next.reunion).toBe(reunion);
    });
});

describe('selectQixiWordTurn', () => {
    it('accepts exactly one User word before waiting for the Char response', () => {
        expect(selectQixiWordTurn([], 0, 'warm')).toEqual(['warm']);
        expect(selectQixiWordTurn(['warm'], 0, 'brave')).toEqual(['warm']);
        expect(selectQixiWordTurn(['warm'], 1, 'brave')).toEqual(['warm', 'brave']);
    });

    it('stops after three alternating picks and cannot pick the same word twice', () => {
        expect(selectQixiWordTurn(['warm'], 1, 'warm')).toEqual(['warm']);
        expect(selectQixiWordTurn(['warm', 'brave', 'quiet'], 3, 'patient')).toEqual(['warm', 'brave', 'quiet']);
    });
});
