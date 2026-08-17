import { describe, expect, it } from 'vitest';
import { qixiStageToBGMGroup } from '../components/events/qixi/QixiBGM';

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
