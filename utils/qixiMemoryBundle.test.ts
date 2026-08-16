import { describe, expect, it } from 'vitest';
import { parseQixiMemoryBundle } from './qixiMemoryBundle';

const validBundle = {
    anchors: [
        { id: 'm1', fact: '用户曾把一张修改了很多次的图发给角色看。', object: '修改过的图' },
        { id: 'm2', fact: '两人在一次沉默之后重新把话说完。', object: '没说完的话' },
    ],
    beats: Object.fromEntries([
        'coldCorridor', 'bracketCorner', 'lightWell', 'maskCounter',
        'receiptRain', 'unsentPlatform', 'typingShaft',
    ].map((nodeId, index) => [nodeId, {
        anchorId: index % 2 ? 'm2' : 'm1',
        memoryLine: `第${index + 1}处认出了那段真实记忆。`,
        ritualAction: '把记忆里的那一步重新穿过针孔',
        result: '细线沿着真实留下的痕迹亮了起来。',
        extension: '它没有替谁证明爱，只留下愿意继续做好的那一步。',
    }])),
    finalEcho: '后来再遇见相似的事，你还是会想起我。',
};

describe('parseQixiMemoryBundle', () => {
    it('accepts fenced JSON and normalizes it into a memory bundle', () => {
        const parsed = parseQixiMemoryBundle(`\`\`\`json\n${JSON.stringify(validBundle)}\n\`\`\``);
        expect(parsed?.source).toBe('memory');
        expect(parsed?.anchors).toHaveLength(2);
        expect(Object.keys(parsed?.beats || {})).toHaveLength(7);
        expect(parsed?.beats.bracketCorner?.anchorId).toBe('m2');
    });

    it('rejects sparse or dangling material instead of presenting it as personal memory', () => {
        const malformed = {
            anchors: [{ id: 'm1', fact: '只有一条很短的记忆事实。', object: '纸条' }],
            beats: {
                bracketCorner: {
                    anchorId: 'missing',
                    memoryLine: '这条引用不存在。',
                    ritualAction: '穿线',
                    result: '没有结果。',
                    extension: '没有引申。',
                },
            },
        };
        expect(parseQixiMemoryBundle(JSON.stringify(malformed))).toBeNull();
    });
});
