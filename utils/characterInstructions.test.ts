import { describe, expect, it } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { DEFAULT_AI_COMPANION_INSTRUCTIONS, getCharacterInstructions, isDefaultAiCompanionEnabled } from './characterInstructions';
import { parseImportedCharacterCard } from './tavernImport';

const profile = (patch: Partial<CharacterProfile> = {}): CharacterProfile => ({
    id: 'character', name: '人物', systemPrompt: '', description: '', avatar: '', memories: [],
    timeAwarenessEnabled: false, scheduleFeatureEnabled: false, ...patch,
});
const user = { name: '玩家', bio: '' } as UserProfile;

describe('per-character default identity', () => {
    it('preserves legacy default and custom profiles', () => {
        expect(getCharacterInstructions(profile())).toBe(DEFAULT_AI_COMPANION_INSTRUCTIONS);
        expect(getCharacterInstructions(profile({ systemPrompt: '你是冒险家' }))).toBe('你是冒险家');
    });
    it('turns fallback off for new and existing Tavern imports and permits explicit override', () => {
        const card = parseImportedCharacterCard(JSON.stringify({ name: '人物', first_mes: '开场' }));
        expect(card.defaultAiCompanionEnabled).toBe(false);
        const char = profile({ tavernImport: card.tavernImport });
        expect(isDefaultAiCompanionEnabled(char)).toBe(false);
        expect(getCharacterInstructions(char)).not.toContain('AI伴侣');
        expect(getCharacterInstructions({ ...char, defaultAiCompanionEnabled: true })).toBe(DEFAULT_AI_COMPANION_INSTRUCTIONS);
    });
    it('removes a previously saved default sentence when disabled, retaining actual custom settings', () => {
        const char = profile({ defaultAiCompanionEnabled: false, systemPrompt: DEFAULT_AI_COMPANION_INSTRUCTIONS });
        expect(getCharacterInstructions(char)).not.toContain('AI伴侣');
        expect(getCharacterInstructions({ ...char, systemPrompt: '你是冒险家\n原始性格' })).toContain('你是冒险家\n原始性格');
    });
    it('uses the same choice in actual shared role and core contexts', async () => {
        const char = profile({ defaultAiCompanionEnabled: false, worldview: '架空大陆' });
        const core = (await ContextBuilder.buildCharacterContext({ char, user })).coreContext;
        const role = await ContextBuilder.buildRoleSettingsContext(char);
        expect(core).not.toContain('AI伴侣');
        expect(role).not.toContain('AI伴侣');
        expect(core).toContain('架空大陆');
        expect(role).toContain('架空大陆');
        expect(core).toContain('请扮演');
        expect(role).toContain('请扮演');
    });
});
