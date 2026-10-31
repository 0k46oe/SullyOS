import { describe, expect, it } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';
import { resolveCharacterUserProfile } from './characterUserProfile';
import { ContextBuilder } from './context';
import { stripSensitiveCardFields } from './characterCard';
import { resolveStoryTheaterMask } from './storyTheater';
import { DB } from './db';

const user = { name: '全局玩家', bio: '全局档案', avatar: 'avatar', perCharAvatars: { a: 'a.png' } } as UserProfile;
const character = (id: string, name: string, bio: string) => ({
    id, name: '角色' + id, systemPrompt: '扮演人物', timeAwarenessEnabled: false,
    characterUserProfile: { enabled: true, name, bio },
    mountedWorldbooks: [{ id: 'book', name: '世界书', content: '{{user}}的故事', constant: true }],
}) as CharacterProfile;

describe('per-character player identity', () => {
    it('isolates characters and restores the unchanged global identity when disabled', () => {
        const a = character('a', '冒险者', '来自森林');
        const b = character('b', '侦探', '来自都市');
        expect(resolveCharacterUserProfile(user, a)).toMatchObject({ name: '冒险者', bio: '来自森林', avatar: 'avatar' });
        expect(resolveCharacterUserProfile(user, b)).toMatchObject({ name: '侦探', bio: '来自都市' });
        expect(resolveCharacterUserProfile(user, { characterUserProfile: { ...a.characterUserProfile!, enabled: false } })).toBe(user);
        expect(user.name).toBe('全局玩家');
        expect(resolveCharacterUserProfile(user, a).perCharAvatars).toBe(user.perCharAvatars);
    });

    it('allows an empty private bio without leaking the global bio', () => {
        expect(resolveCharacterUserProfile(user, character('a', ' ', ''))).toMatchObject({ name: '全局玩家', bio: '' });
    });

    it('uses the same identity in the user prompt, worldbook macros and read-only preview', async () => {
        const char = character('a', '冒险者', '来自森林');
        const result = await ContextBuilder.buildCharacterContext({ char, user, history: [{ role: 'user', content: '你好' }] });
        const text = JSON.stringify(result.messages);
        expect(text).toContain('冒险者');
        expect(text).toContain('来自森林');
        expect(text).toContain('冒险者的故事');
        expect(text).not.toContain('全局档案');
        expect(ContextBuilder.inspectWorldbooks(char, user, [])[0].content).toBe('冒险者的故事');
    });

    it('uses the private identity for the default theater mask and honors an explicit mask', () => {
        const char = character('a', '冒险者', '来自森林');
        expect(resolveStoryTheaterMask({ type: 'user' }, user, [char], [], char)).toMatchObject({ name: '冒险者', description: '来自森林' });
        const mask = { id: 'mask', name: '旅人', avatar: '', description: '面具身份', coreInstruction: '', worldview: '' };
        expect(resolveStoryTheaterMask({ type: 'custom', id: 'mask' }, user, [char], [mask], char).name).toBe('旅人');
    });

    it('persists with the character, but excludes private player data from shared cards', async () => {
        const char = character('private-profile', '冒险者', '私有背景');
        await DB.saveCharacter(char);
        expect((await DB.getAllCharacters()).find(item => item.id === char.id)?.characterUserProfile).toEqual(char.characterUserProfile);
        const shared = stripSensitiveCardFields(char);
        expect(shared).not.toHaveProperty('characterUserProfile');
        expect(char.characterUserProfile?.bio).toBe('私有背景');
    });
});
