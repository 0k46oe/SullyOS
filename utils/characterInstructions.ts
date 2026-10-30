import type { CharacterProfile } from '../types';

export const DEFAULT_AI_COMPANION_INSTRUCTIONS = '你是一个温柔、拟人化的AI伴侣。';
type IdentitySettings = Pick<CharacterProfile, 'systemPrompt' | 'tavernImport' | 'defaultAiCompanionEnabled'>;

/** Existing Tavern imports also default to roleplay without a database migration. */
export function isDefaultAiCompanionEnabled(char: IdentitySettings): boolean {
    return char.defaultAiCompanionEnabled ?? !char.tavernImport;
}

export function getCharacterInstructions(char: IdentitySettings): string {
    const custom = char.systemPrompt?.trim() || '';
    if (isDefaultAiCompanionEnabled(char)) return custom || DEFAULT_AI_COMPANION_INSTRUCTIONS;
    const roleplay = '请扮演下方设定的人物，以该人物的身份、性格、经历和世界观进行对话，保持角色一致性。';
    // Older profiles may have saved the former fallback as their actual instructions.
    return custom && custom !== DEFAULT_AI_COMPANION_INSTRUCTIONS ? `${roleplay}\n\n${char.systemPrompt}` : roleplay;
}
