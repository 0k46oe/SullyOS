import type { CharacterProfile, UserProfile } from '../types';

/** Resolve a private per-character identity without changing the global archive. */
export function resolveCharacterUserProfile(user: UserProfile, character?: Pick<CharacterProfile, 'characterUserProfile'> | null): UserProfile {
    const profile = character?.characterUserProfile;
    if (!profile?.enabled) return user;
    return { ...user, name: profile.name.trim() || user.name, bio: profile.bio };
}
