import { describe, expect, it } from 'vitest';
import { buildQixiMemoryBundlePhasePrompt, buildQixiMemoryBundlePrompt, parseQixiMemoryBundle, QIXI_FALLBACK_CHAR_QUIPS, QIXI_FALLBACK_CHAR_VISIBLE_TEXT, QIXI_FALLBACK_TRANSITIONS, QIXI_MEMORY_BUNDLE_VERSION, QIXI_PART1_FIRST_SCENE_IDS, QIXI_PART1_SECOND_SCENE_IDS, QIXI_RECALL_MAX_OUTPUT_ITEMS, QIXI_SCENE_IDS } from './qixiMemoryBundle';

const evidence = Array.from({ length: 20 }, (_, index) => ({
    id: `e${index + 1}`,
    fact: `第 ${index + 1} 条来自真实聊天、可以核对的具体记忆事实。`,
    object: `物件${index + 1}`,
    tags: ['日常'],
}));

const artifacts = Array.from({ length: 18 }, (_, index) => ({
    id: `a${index + 1}`,
    label: `记忆词${index + 1}`,
    kind: index < 16 ? 'trait' : (index % 2 ? 'phrase' : 'object'),
    evidenceIds: [`e${(index % evidence.length) + 1}`],
}));

const validBundle = {
    openingChat: ['你刚才是不是回我了？', '奇怪，我这里没收到。'],
    charLayerColor: '#82D5B8',
    charPerformance: { tempo: 'brisk', markStyle: 'precise', presence: 'direct' },
    evidence,
    artifacts,
    scenes: Object.fromEntries(QIXI_SCENE_IDS.map((sceneId, sceneIndex) => [sceneId, {
        transitionLines: [`第${sceneIndex + 1}个空间正在从上一处留下的痕迹里浮现。`],
        sharedObject: `第${sceneIndex + 1}站的共享物件`,
        memoryLine: `第${sceneIndex + 1}站从真实记忆里浮起了一段具体内容。`,
        options: sceneId === 'wordCloud' ? [] : [0, 1, 2].map(index => ({
            id: `${sceneId}-${index}`,
            label: sceneId === 'doubleWish' ? `希望我们以后一起完成第${index + 1}件事` : `执行第${index + 1}个真实动作`,
            result: `这个动作让第${sceneIndex + 1}站出现了可见的梦境反馈。`,
            ...(sceneId === 'lostLayer' ? { charReply: `关于第${index + 1}个真实话题，我确实收到了。` } : {}),
            evidenceIds: [`e${sceneIndex + 1}`],
        })),
        charAction: sceneId === 'lostLayer' ? '另一色字迹直接扑向弹出的报错，把 DELIVERY FAILED 撕碎并踢出发送框。' : '另一种颜色从物件背面出现，完成了另一层正在进行的操作。',
        ...(sceneId === 'lostLayer' ? { charMutter: '啧，给我让开。' } : {}),
        ...(sceneId === 'offerings' ? { charContribution: '一颗系着细线的糖' } : {}),
        charVisibleText: sceneId === 'lostLayer' ? '挡路的，删掉。' : sceneId === 'doubleWish' ? '希望以后还能和你一起认真期待明天。' : '',
        charQuips: sceneId === 'wordCloud'
            ? ['这词像你，别申诉。', '又来一个，证据增加。', '最后一个归我，不接受复议。']
            : sceneId === 'lostLayer'
                ? ['道歉留着自己看。', '这次不许再吞。']
            : sceneId === 'doubleWish'
                ? ['这面先别看，我写得有点太认真了。']
                : ['这东西的运行逻辑很可疑。'],
        reveal: '这一站只向前推进一层发现，不直接宣布另一边是谁。',
        artifactIds: sceneId === 'wordCloud' ? artifacts.slice(0, 16).map(item => item.id) : [`a${sceneIndex + 1}`],
        charSelectionIds: sceneId === 'wordCloud' ? ['a1', 'a3', 'a5'] : [],
    }])),
};

describe('parseQixiMemoryBundle v17', () => {
    it('keeps the prompt option contract aligned with the parser minimum', () => {
        const prompt = buildQixiMemoryBundlePrompt({ name: 'Char' } as any, { name: 'User' } as any);
        expect(QIXI_MEMORY_BUNDLE_VERSION).toBe(17);
        expect(QIXI_RECALL_MAX_OUTPUT_ITEMS).toBe(20);
        expect(prompt).toContain('不要证明 Char 记得 User，而要让 Char 使用这些记忆与 User 做事');
        expect(prompt).toContain('记忆是玩法材料，不是展示内容');
        expect(prompt).toContain('七站必须组成一条连续发展的“双人异常事件”');
        expect(prompt).toContain('事实不可虚构，演出可以虚构');
        expect(prompt).toContain('不能创造假的过去，可以创造新的现在');
        expect(prompt).toContain('至少四站要出现一次意外、失败、抢夺、擅自修改、互相妨碍或故意不配合');
        expect(prompt).toContain('展示动作证据，不替玩家解释证据');
        expect(prompt).toContain('前六站必须各提供恰好 3 个完整 options');
        expect(prompt).toContain('每个 option 自己都必须引用至少一个有效 evidence');
        expect(prompt).toContain('wordCloud 恰好 3 句');
        expect(prompt).toContain('电波感开到约 7/10');
        expect(prompt).toContain('你想到的那个人是什么性格');
        expect(prompt).toContain('User 会从中选 3 个最像 Char 的词');
        expect(prompt).toContain('不要放物件、日期、话题、称呼、愿望');
        expect(prompt).toContain('kind="trait"');
        expect(prompt).toContain('必须直接写成 Char 第一人称许下的完整愿望句');
        expect(prompt).toContain('"charVisibleText": "希望以后还能和你一起认真期待明天。"');
        expect(prompt).toContain('接着和 Char 聊哪段真实记忆');
        expect(prompt).toContain('禁止脱离 evidence 的泛泛问候');
        expect(prompt).toContain('玩家可见文案绝不能出现 e1、e2、evidenceId 等内部编号');
        expect(prompt).toContain('User 选择记忆相关话题 → 尝试发送 → DELIVERY FAILED、API 限流、超时与软道歉红框铺满空间');
        expect(prompt).toContain('提取 20 条互不重复的事实证据');
        expect(prompt).toContain('Char 的视觉动作、charVisibleText、charMutter 与 charQuips 只能攻击报错');
        expect(prompt).toContain('严禁“数据流 / 字符化 / 上下文 / 协议 / 接口 / 系统指令”等技术隐喻');
        expect(prompt).toContain('角色不是记忆宫殿的讲解员');
        expect(prompt).toContain('Char 与 User 是对称受困者');
        expect(prompt).toContain('同样突然找不到 User');
        expect(prompt).toContain('至少三站先写出 Char 自己的目的');
        expect(prompt).toContain('前几站不能直接叫 User');
        expect(prompt).toContain('至少三站的碎碎念不直接提 evidence');
        expect(prompt).toContain('找不到 User 时没说出口的担心');
        expect(prompt).toContain('对应 option.charReply 穿过清出的空隙出现');
        expect(prompt).toContain('offerings 必须提供 charContribution');
        expect(prompt).toContain('窗台房间 / Window Sill');
        expect(prompt).toContain('"charQuips": ["这面先别看，我写得有点太认真了。"]');
        for (const optionPrefix of ['topic', 'doubleWish', 'threadNeedle', 'offerings', 'reflection', 'nightMarket']) {
            expect(prompt).toContain(`"id": "${optionPrefix}-1"`);
            expect(prompt).toContain(`"id": "${optionPrefix}-2"`);
            expect(prompt).toContain(`"id": "${optionPrefix}-3"`);
        }
        expect(prompt).toContain('"wordCloud": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": []');
    });

    it('splits Part 1 into four scenes followed by three continuation scenes', () => {
        const firstPrompt = buildQixiMemoryBundlePhasePrompt({ name: 'Char' } as any, { name: 'User' } as any, undefined, 'first');
        const secondPrompt = buildQixiMemoryBundlePhasePrompt({ name: 'Char' } as any, { name: 'User' } as any, undefined, 'second', '{"completedScenes":{}}');
        expect(QIXI_PART1_FIRST_SCENE_IDS).toEqual(['lostLayer', 'doubleWish', 'threadNeedle', 'offerings']);
        expect(QIXI_PART1_SECOND_SCENE_IDS).toEqual(['reflection', 'nightMarket', 'wordCloud']);
        expect(firstPrompt).toContain('第一段生成');
        expect(firstPrompt).toContain('scenes 必须且只能包含 lostLayer、doubleWish、threadNeedle、offerings');
        expect(secondPrompt).toContain('第二段生成');
        expect(secondPrompt).toContain('scenes 必须且只能包含 reflection、nightMarket、wordCloud');
        expect(secondPrompt).toContain('{"completedScenes":{}}');
    });

    it('keeps a rich 20-item evidence pool instead of truncating it to fifteen anchors', () => {
        const parsed = parseQixiMemoryBundle(`\`\`\`json\n${JSON.stringify(validBundle)}\n\`\`\``, 'ctx-1');
        expect(parsed?.source).toBe('memory');
        expect(parsed?.openingChat).toEqual(validBundle.openingChat);
        expect(parsed?.charLayerColor).toBe('#82D5B8');
        expect(parsed?.charPerformance).toEqual(validBundle.charPerformance);
        expect(parsed?.evidence).toHaveLength(20);
        expect(parsed?.artifacts).toHaveLength(18);
        expect(parsed?.personalizedSceneIds).toEqual(QIXI_SCENE_IDS);
        expect(parsed?.scenes.lostLayer.transitionLines).toEqual(validBundle.scenes.lostLayer.transitionLines);
        expect(parsed?.scenes.lostLayer.charVisibleText).toBe(validBundle.scenes.lostLayer.charVisibleText);
        expect(parsed?.scenes.lostLayer.charAction).toBe(validBundle.scenes.lostLayer.charAction);
        expect(parsed?.scenes.lostLayer.charMutter).toBe(validBundle.scenes.lostLayer.charMutter);
        expect(parsed?.scenes.lostLayer.options[0].charReply).toBe(validBundle.scenes.lostLayer.options[0].charReply);
        expect(parsed?.scenes.offerings.charContribution).toBe(validBundle.scenes.offerings.charContribution);
        expect(parsed?.scenes.doubleWish.charQuips).toEqual(validBundle.scenes.doubleWish.charQuips);
        expect(parsed?.scenes.threadNeedle.charQuips).toEqual(validBundle.scenes.threadNeedle.charQuips);
        expect(parsed?.scenes.wordCloud.charQuips).toHaveLength(3);
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
        let reason = '';
        expect(parseQixiMemoryBundle(JSON.stringify(missingTransition), '', value => { reason = value; })).toBeNull();
        expect(reason).toContain('offerings.transitionLines');
    });

    it('keeps the first-room Char rescue fields after the player topic choice', () => {
        const intervention = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                lostLayer: {
                    ...validBundle.scenes.lostLayer,
                    charAction: 'Char 从另一层冲进来修复了报错。',
                    charVisibleText: '碍事的，滚开。',
                    charMutter: '让我来修。',
                },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(intervention));
        expect(parsed?.source).toBe('memory');
        expect(parsed?.scenes.lostLayer.charAction).toBe('Char 从另一层冲进来修复了报错。');
        expect(parsed?.scenes.lostLayer.charVisibleText).toBe('碍事的，滚开。');
        expect(parsed?.scenes.lostLayer.charMutter).toBe('让我来修。');
    });

    it('falls back when Char attacks or rescues the User topic instead of the popup error', () => {
        const wrongTarget = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                lostLayer: {
                    ...validBundle.scenes.lostLayer,
                    charAction: '另一色字迹冲进来，改写并抢救选中的话题。',
                    charVisibleText: '这句话不准丢。',
                },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(wrongTarget));
        expect(parsed?.source).toBe('memory');
        expect(parsed?.personalizedSceneIds).not.toContain('lostLayer');
        expect(parsed?.scenes.lostLayer.charAction).toContain('扑向弹出的 DELIVERY FAILED');
        expect(parsed?.scenes.lostLayer.charVisibleText).toBe(QIXI_FALLBACK_CHAR_VISIBLE_TEXT.lostLayer);
    });

    it('replaces unreadable generated room transitions without replacing the LLM-generated scene', () => {
        const jargonTransition = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                doubleWish: {
                    ...validBundle.scenes.doubleWish,
                    transitionLines: ['被抢救回来的字符化作数据流。', '飘下一张带【CYBERORDER】标识的祈愿笺。'],
                },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(jargonTransition));
        expect(parsed?.source).toBe('memory');
        expect(parsed?.personalizedSceneIds).toContain('doubleWish');
        expect(parsed?.scenes.doubleWish.transitionLines).toEqual(QIXI_FALLBACK_TRANSITIONS.doubleWish);
        expect(parsed?.repairNotes).toContain('doubleWish.transitionLines 出现系统设定黑话，已替换为本地可读过场');
    });

    it('rejects Part 1 when the first-room rescue omits its mutter', () => {
        const missingMutter = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                lostLayer: { ...validBundle.scenes.lostLayer, charMutter: '' },
            },
        };
        expect(parseQixiMemoryBundle(JSON.stringify(missingMutter))).toBeNull();
    });

    it('falls back from developer-task choices to evidence-grounded player topics', () => {
        const developerRoom = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                lostLayer: {
                    ...validBundle.scenes.lostLayer,
                    sharedObject: '部署控制台',
                    memoryLine: '日志显示接口部署失败。',
                    options: validBundle.scenes.lostLayer.options.map((option, index) => ({
                        ...option,
                        label: index === 0 ? '修 bug' : index === 1 ? '重新部署接口' : '查看错误日志',
                    })),
                },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(developerRoom));
        expect(parsed?.source).toBe('memory');
        expect(parsed?.personalizedSceneIds).not.toContain('lostLayer');
        expect(parsed?.scenes.lostLayer.options.map(option => option.label)).toEqual([
            '问问 ta「物件1」后来怎么样',
            '把「物件2」那件事接着说完',
            '拿「物件3」试探一下 ta',
        ]);
        expect(parsed?.scenes.lostLayer.options.map(option => option.evidenceIds)).toEqual([['e1'], ['e2'], ['e3']]);
    });

    it('does not accept generated topic choices without their own valid evidence', () => {
        const ungroundedTopics = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                lostLayer: {
                    ...validBundle.scenes.lostLayer,
                    options: validBundle.scenes.lostLayer.options.map(option => ({ ...option, evidenceIds: ['missing'] })),
                },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(ungroundedTopics));
        expect(parsed?.source).toBe('memory');
        expect(parsed?.personalizedSceneIds).not.toContain('lostLayer');
        expect(parsed?.scenes.lostLayer.options.every(option => option.evidenceIds.length === 1)).toBe(true);
        expect(parsed?.scenes.lostLayer.options[0].label).toContain('物件1');
    });

    it('falls back a room unless the first six rooms each expose three usable choices', () => {
        const onlyTwoChoices = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                threadNeedle: {
                    ...validBundle.scenes.threadNeedle,
                    options: validBundle.scenes.threadNeedle.options.slice(0, 2),
                },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(onlyTwoChoices));
        expect(parsed?.source).toBe('memory');
        expect(parsed?.personalizedSceneIds).not.toContain('threadNeedle');
        expect(parsed?.scenes.threadNeedle.options).toHaveLength(3);
    });

    it('requires a topic-specific Char reply on every lost-layer choice', () => {
        const missingReply = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                lostLayer: {
                    ...validBundle.scenes.lostLayer,
                    options: validBundle.scenes.lostLayer.options.map((option, index) => index === 1 ? { ...option, charReply: '' } : option),
                },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(missingReply));
        expect(parsed?.personalizedSceneIds).not.toContain('lostLayer');
        expect(parsed?.scenes.lostLayer.options.every(option => (option.charReply?.length || 0) >= 4)).toBe(true);
    });

    it('requires Char to place a separate offering of their own', () => {
        const missingContribution = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                offerings: { ...validBundle.scenes.offerings, charContribution: '' },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(missingContribution));
        expect(parsed?.personalizedSceneIds).not.toContain('offerings');
        expect(parsed?.scenes.offerings.charContribution).toBe('一颗被捏得有点歪的星星糖');
    });

    it('does not leak internal evidence ids into player-facing room copy', () => {
        const leakedReference = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                lostLayer: {
                    ...validBundle.scenes.lostLayer,
                    options: validBundle.scenes.lostLayer.options.map((option, index) => ({
                        ...option,
                        label: `接着聊 e${index + 1} 里的具体事情`,
                    })),
                },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(leakedReference));
        expect(parsed?.personalizedSceneIds).not.toContain('lostLayer');
        expect(parsed?.scenes.lostLayer.options.some(option => /e\d+/i.test(option.label))).toBe(false);
    });

    it('does not require explanatory Char overlay text in the later five rooms', () => {
        const withoutLaterOverlayCopy = {
            ...validBundle,
            scenes: Object.fromEntries(Object.entries(validBundle.scenes).map(([sceneId, scene]) => [
                sceneId,
                ['lostLayer', 'doubleWish'].includes(sceneId) ? scene : { ...scene, charVisibleText: '' },
            ])),
        };
        expect(parseQixiMemoryBundle(JSON.stringify(withoutLaterOverlayCopy))?.source).toBe('memory');
    });

    it.each([
        ['', '缺失或过短'],
        ['希望系统别再把数据弄丢。', '写成了系统说明'],
        ['希望你每天都开心。', '只在祝福 User'],
        ['希望我以后能更勇敢。', '没有写两个人的未来'],
    ])('repairs an unusable Char wish locally without discarding Part 1: %s', (charVisibleText, reason) => {
        const bundleWithBadWish = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                doubleWish: { ...validBundle.scenes.doubleWish, charVisibleText },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(bundleWithBadWish));
        expect(parsed?.source).toBe('memory');
        expect(parsed?.scenes.doubleWish.charVisibleText).toBe(QIXI_FALLBACK_CHAR_VISIBLE_TEXT.doubleWish);
        expect(parsed?.repairNotes?.[0]).toContain(reason);
        expect(parsed?.personalizedSceneIds).toContain('doubleWish');
    });

    it.each<[string[]]>([
        [[]],
        [['系统提示：愿望数据已写入。']],
    ])('repairs a missing or meta double-wish aside without discarding Part 1: %j', charQuips => {
        const bundleWithBadAside = {
            ...validBundle,
            scenes: {
                ...validBundle.scenes,
                doubleWish: { ...validBundle.scenes.doubleWish, charQuips },
            },
        };
        const parsed = parseQixiMemoryBundle(JSON.stringify(bundleWithBadAside));
        expect(parsed?.source).toBe('memory');
        expect(parsed?.personalizedSceneIds).toContain('doubleWish');
        expect(parsed?.scenes.doubleWish.charQuips).toEqual(QIXI_FALLBACK_CHAR_QUIPS.doubleWish);
        expect(parsed?.repairNotes).toContain('doubleWish.charQuips 缺失或写成系统说明，已替换为本地私人碎碎念');
    });

    it('requires in-character remarks for the later rooms and all three word-cloud turns', () => {
        const missingRoomQuip = {
            ...validBundle,
            scenes: { ...validBundle.scenes, reflection: { ...validBundle.scenes.reflection, charQuips: [] } },
        };
        const shortWordCloudQuips = {
            ...validBundle,
            scenes: { ...validBundle.scenes, wordCloud: { ...validBundle.scenes.wordCloud, charQuips: ['只有一句'] } },
        };
        expect(parseQixiMemoryBundle(JSON.stringify(missingRoomQuip))).toBeNull();
        expect(parseQixiMemoryBundle(JSON.stringify(shortWordCloudQuips))).toBeNull();
    });

    it('keeps non-trait artifacts out of the personality word cloud', () => {
        const nonTraitArtifacts = artifacts.map(item => ({ ...item, kind: 'object' }));
        const parsed = parseQixiMemoryBundle(JSON.stringify({ ...validBundle, artifacts: nonTraitArtifacts }));
        expect(parsed?.personalizedSceneIds).not.toContain('wordCloud');
        expect(parsed?.scenes.wordCloud.artifactIds).toEqual([]);
    });
});
