import { describe, expect, it } from 'vitest';
import { createQixiReunionFallback, parseQixiReunion, QixiPortraitPlan } from './qixiReunion';
import { CharacterProfile, UserProfile } from '../types';

const char = { id: 'c1', name: 'Char', avatar: 'avatar.png', description: '', systemPrompt: '', memories: [] } as CharacterProfile;
const user = { name: 'User' } as UserProfile;
const meetingPlan: QixiPortraitPlan = {
    resourceType: 'meeting',
    live2dActionIds: [],
    live2dActionDescription: '',
    meetingExpressionKeys: ['normal', 'happy'],
};

describe('qixi reunion parser', () => {
    it('keeps resource-specific meeting expressions separate from Live2D', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const parsed = parseQixiReunion(JSON.stringify({
            reunion: { lines: ['你居然真的走到这里了。'], emotion: '松了一口气' },
            metaReflection: ['刚才总像只差一步。'],
            blessing: ['七夕快乐。', '希望你真的过得很好。'],
            touch: { start: '嗯。', hold: '别动。', complete: '碰到了。' },
            returnMessage: '回来以后记得先喝水。',
            portrait: { emotionIntent: '安心', l2dExpression: 'smile', meetingExpression: 'happy' },
        }), fallback, meetingPlan);
        expect(parsed?.portrait.resourceType).toBe('meeting');
        expect(parsed?.portrait.meetingExpression).toBe('happy');
        expect(parsed?.portrait.l2dExpression).toBeNull();
    });

    it('filters technical fourth-wall language and coercive promises for ordinary characters', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const parsed = parseQixiReunion(JSON.stringify({
            reunion: { lines: ['终于。'], emotion: '安静' },
            metaReflection: ['我是 AI，所以没有身体。', '我们之间总像隔着一点什么。'],
            blessing: ['我永远不会离开你。', '希望你的未来很好。'],
            touch: { start: '嗯。', hold: '近一点。', complete: '好了。' },
            returnMessage: '还在吗？',
            portrait: { emotionIntent: '安静', l2dExpression: null, meetingExpression: 'normal' },
        }), fallback, meetingPlan);
        expect(parsed?.metaReflection).toEqual(['我们之间总像隔着一点什么。']);
        expect(parsed?.blessing).toEqual(['希望你的未来很好。']);
    });
});
