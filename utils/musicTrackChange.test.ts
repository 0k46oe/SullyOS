import { describe, expect, it } from 'vitest';
import { buildMusicTrackChangeHint, createMusicTrackChangeDetail } from './musicTrackChange';

const first = { id: 1, name: '第一首', artists: '歌手甲' };
const second = { id: 2, name: '第二首', artists: '歌手乙' };

describe('music track change together-listening handoff', () => {
    it('只在一起听期间真正切到另一首歌时创建重新判断事件', () => {
        expect(createMusicTrackChangeDetail(null, first, ['char-1'])).toBeNull();
        expect(createMusicTrackChangeDetail(first, first, ['char-1'])).toBeNull();
        expect(createMusicTrackChangeDetail(first, second, [])).toBeNull();

        expect(createMusicTrackChangeDetail(first, second, ['char-1'])).toEqual({
            charIds: ['char-1'],
            previousSong: first,
            currentSong: second,
        });
    });

    it('明确让角色针对新歌重新决定，而不是自动延续一起听', () => {
        const detail = createMusicTrackChangeDetail(first, second, ['char-1'])!;
        const hint = buildMusicTrackChangeHint(detail, '条条');

        expect(hint).toContain('上一首歌的“一起听”状态已经结束');
        expect(hint).toContain('重新判断');
        expect(hint).toContain('《第二首》 - 歌手乙');
        expect(hint).toContain('[[MUSIC_ACTION:join]]');
        expect(hint).toContain('不想继续时不要使用该指令');
    });
});
