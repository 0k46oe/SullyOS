import { describe, expect, it } from 'vitest';
import { parseQixiMemoryBundle, QIXI_SCENE_IDS } from './qixiMemoryBundle';

const evidence = Array.from({ length: 14 }, (_, index) => ({
    id: `e${index + 1}`,
    fact: `第 ${index + 1} 条来自真实聊天、可以核对的具体记忆事实。`,
    object: `物件${index + 1}`,
    tags: ['日常'],
}));

const artifacts = Array.from({ length: 18 }, (_, index) => ({
    id: `a${index + 1}`,
    label: `记忆词${index + 1}`,
    kind: index % 2 ? 'phrase' : 'object',
    evidenceIds: [`e${(index % evidence.length) + 1}`],
}));

const validBundle = {
    openingChat: ['你刚才是不是回我了？', '奇怪，我这里没收到。'],
    evidence,
    artifacts,
    scenes: Object.fromEntries(QIXI_SCENE_IDS.map((sceneId, sceneIndex) => [sceneId, {
        transitionLines: [`第${sceneIndex + 1}个空间正在从上一处留下的痕迹里浮现。`],
        sharedObject: `第${sceneIndex + 1}站的共享物件`,
        memoryLine: `第${sceneIndex + 1}站从真实记忆里浮起了一段具体内容。`,
        options: sceneId === 'wordCloud' ? [] : [0, 1, 2].map(index => ({
            id: `${sceneId}-${index}`,
            label: `执行第${index + 1}个真实动作`,
            result: `这个动作让第${sceneIndex + 1}站出现了可见的梦境反馈。`,
            evidenceIds: [`e${sceneIndex + 1}`],
        })),
        charAction: '另一种颜色从物件背面出现，完成了另一层正在进行的操作。',
        ...(sceneId === 'lostLayer' ? { charMutter: '啧，这破东西又挡路。' } : {}),
        charVisibleText: `第${sceneIndex + 1}站的蓝色核心短句`,
        reveal: '这一站只向前推进一层发现，不直接宣布另一边是谁。',
        artifactIds: sceneId === 'wordCloud' ? artifacts.slice(0, 16).map(item => item.id) : [`a${sceneIndex + 1}`],
        charSelectionIds: sceneId === 'wordCloud' ? ['a1', 'a3', 'a5'] : [],
    }])),
};

describe('parseQixiMemoryBundle v6', () => {
    it('keeps a rich 12–18 evidence pool instead of truncating it to five anchors', () => {
        const parsed = parseQixiMemoryBundle(`\`\`\`json\n${JSON.stringify(validBundle)}\n\`\`\``, 'ctx-1');
        expect(parsed?.source).toBe('memory');
        expect(parsed?.openingChat).toEqual(validBundle.openingChat);
        expect(parsed?.evidence).toHaveLength(14);
        expect(parsed?.artifacts).toHaveLength(18);
        expect(parsed?.personalizedSceneIds).toEqual(QIXI_SCENE_IDS);
        expect(parsed?.scenes.lostLayer.transitionLines).toEqual(validBundle.scenes.lostLayer.transitionLines);
        expect(parsed?.scenes.lostLayer.charVisibleText).toBe(validBundle.scenes.lostLayer.charVisibleText);
        expect(parsed?.scenes.lostLayer.charMutter).toBe(validBundle.scenes.lostLayer.charMutter);
        expect(parsed?.scenes.wordCloud.artifactIds).toHaveLength(16);
        expect(parsed?.contextSignature).toBe('ctx-1');
    });

    it('caps evidence at 24 and rejects artifacts that do not cite real evidence', () => {
        const oversized = {
            ...validBundle,
            evidence: Array.from({ length: 30 }, (_, index) => ({ id: `e${index}`, fact: `足够具体的事实 ${index}`, object: '物件' })),
            artifacts: [...artifacts, { id: 'dangling', label: '凭空出现', kind: 'object', evidenceIds: ['missing'] }],
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(oversized));
        expect(parsed?.evidence).toHaveLength(24);
        expect(parsed?.artifacts.some(item => item.id === 'dangling')).toBe(false);
    });

    it('falls back per scene but rejects a response with fewer than two usable personalized scenes', () => {
        const sparse = {
            evidence: evidence.slice(0, 2),
            artifacts: artifacts.slice(0, 2),
            scenes: {
                lostLayer: validBundle.scenes.lostLayer,
            },
        };
        expect(parseQixiMemoryBundle(JSON.stringify(sparse))).toBeNull();
    });

    it('rejects Part 1 when any room is missing its generated transition', () => {
        const missingTransition = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                offerings: { ...validBundle.scenes.offerings, transitionLines: [] },
            },
        };
        expect(parseQixiMemoryBundle(JSON.stringify(missingTransition))).toBeNull();
    });

    it('rejects Part 1 when a room describes a Char action but omits its visible blue content', () => {
        const missingVisibleContent = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                lostLayer: { ...validBundle.scenes.lostLayer, charVisibleText: '' },
            },
        };
        expect(parseQixiMemoryBundle(JSON.stringify(missingVisibleContent))).toBeNull();
    });

    it('rejects Part 1 when the first room omits Char’s hurried error mutter', () => {
        const missingMutter = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                lostLayer: { ...validBundle.scenes.lostLayer, charMutter: '' },
            },
        };
        expect(parseQixiMemoryBundle(JSON.stringify(missingMutter))).toBeNull();
    });
});
