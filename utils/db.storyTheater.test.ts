import { describe, expect, it } from 'vitest';
import type { StoryTheaterEntry, StoryTheaterMask, StoryTheaterPreset } from '../types';
import { DB } from './db';

describe('剧情剧场数据与糯米机原生预设备份', () => {
    it('完整备份 round-trip 后条目与自定义预设仍存在', async () => {
        const entry: StoryTheaterEntry = {
            id: 'story-backup-entry',
            title: '雨夜车站',
            premise: '三个人错过末班车。',
            characterIds: ['char-a', 'char-b'],
            writesToCharacterMemory: false,
            characterMemoryDates: {},
            carryCharacterMemory: true,
            characterContextLimits: { 'char-a': 100, 'char-b': 80 },
            archiveAfter: 30,
            archiveStrategy: 'summary',
            archives: [],
            selectedWorldbookIds: ['book-a'],
            presetId: 'story-backup-preset',
            createdAt: 10,
            updatedAt: 20,
        };
        const preset: StoryTheaterPreset = {
            id: 'story-backup-preset',
            name: '备份测试',
            format: 'sullyos-story-preset',
            createdAt: 10,
            updatedAt: 20,
            document: {
                schema: 'sullyos.story-preset',
                version: 1,
                name: '备份测试',
                generation: { temperature: 0.8, topP: 1, frequencyPenalty: 0, presencePenalty: 0, maxTokens: 2048 },
                prompts: [{ id: 'p1', name: '规则', enabled: true, role: 'system', content: '只写故事正文。' }],
            },
        };
        const mask: StoryTheaterMask = { id: 'story-mask', name: '夜航员', description: '来自另一条时间线', coreInstruction: '谨慎行动', worldview: '雨城', createdAt: 10, updatedAt: 20 };

        await DB.saveStoryTheater(entry);
        await DB.saveStoryTheaterPreset(preset);
        await DB.saveStoryTheaterMask(mask);
        const exported = JSON.parse(JSON.stringify(await DB.exportFullData()));
        expect(exported.storyTheaters).toContainEqual(entry);
        expect(exported.storyTheaterPresets).toContainEqual(preset);
        expect(exported.storyTheaterMasks).toContainEqual(mask);

        await DB.deleteStoryTheater(entry.id);
        await DB.deleteStoryTheaterPreset(preset.id);
        await DB.deleteStoryTheaterMask(mask.id);
        await DB.importFullData(exported as any);

        expect(await DB.getStoryTheaters()).toContainEqual(entry);
        expect(await DB.getStoryTheaterPresets()).toContainEqual(preset);
        expect(await DB.getStoryTheaterMasks()).toContainEqual(mask);
    });
});
