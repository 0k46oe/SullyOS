import { describe, expect, it, vi } from 'vitest';
import { prepareQixiBGMFadeIn, qixiStageToBGMGroup, stopQixiBGMTrack } from '../components/events/qixi/QixiBGM';

describe('Qixi BGM scene routing', () => {
    it('uses the fall track through scene 01', () => {
        expect(qixiStageToBGMGroup('fakeChat', 0)).toBe('fall');
        expect(qixiStageToBGMGroup('distort', 0)).toBe('fall');
        expect(qixiStageToBGMGroup('sceneTransition', 0)).toBe('fall');
        expect(qixiStageToBGMGroup('scene', 0)).toBe('fall');
    });

    it('switches at scenes 02 and 05', () => {
        expect(qixiStageToBGMGroup('scene', 1)).toBe('explore');
        expect(qixiStageToBGMGroup('sceneTransition', 3)).toBe('explore');
        expect(qixiStageToBGMGroup('scene', 3)).toBe('explore');
        expect(qixiStageToBGMGroup('scene', 4)).toBe('otherSide');
        expect(qixiStageToBGMGroup('scene', 6)).toBe('otherSide');
    });

    it('does not cut between bridge, reunion, promise, and ending', () => {
        ['bridgeLoading', 'bridge', 'bridgeCrossing', 'reunionLoading', 'reunion', 'touch', 'ending'].forEach(stage => {
            expect(qixiStageToBGMGroup(stage, 7)).toBe('bridge');
        });
    });
});

describe('Qixi BGM transitions', () => {
    it('stops and rewinds the previous track immediately', () => {
        const audio = {
            currentTime: 48,
            pause: vi.fn(),
            volume: 0.32,
        };
        stopQixiBGMTrack(audio);
        expect(audio.pause).toHaveBeenCalledOnce();
        expect(audio.currentTime).toBe(0);
        expect(audio.volume).toBe(0);
    });

    it('starts the incoming track from silence for fade-in', () => {
        const audio = { volume: 0.32 };
        prepareQixiBGMFadeIn(audio);
        expect(audio.volume).toBe(0);
    });
});
