import type { CharacterProfile, Message, StoryTheaterEntry } from '../types';
import { openDB } from './db';
import { replaceStoryMacros, storyTheaterThreadId } from './storyTheater';

export function getStoryCardGreetings(actors: CharacterProfile[]): NonNullable<StoryTheaterEntry['cardOpening']>[] {
    return actors.flatMap(actor => [actor.tavernImport?.firstMessage || '', ...(actor.tavernImport?.alternateGreetings || [])]
        .map((content, greetingIndex) => ({ characterId: actor.id, characterName: actor.name, greetingIndex, content }))
        .filter(greeting => greeting.content.trim()));
}

/** Entry, first floor and receipt commit together; retries and concurrent tabs cannot duplicate it. */
export async function saveStoryTheaterWithCardOpening(entry: StoryTheaterEntry, userName: string): Promise<StoryTheaterEntry> {
    const opening = entry.cardOpening;
    if (entry.openingMode !== 'card' || entry.writesToCharacterMemory || !opening?.content.trim() || (!entry.cardOpeningConsumed && !entry.characterIds.includes(opening.characterId))) {
        throw new Error('请选择参与角色的酒馆开场白，并使用虚构剧场模式');
    }
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['story_theaters', 'messages'], 'readwrite');
        const entries = tx.objectStore('story_theaters');
        const messages = tx.objectStore('messages');
        const threadId = storyTheaterThreadId(entry.id);
        const saved = { ...entry, cardOpeningConsumed: true };
        const existingRequest = entries.get(entry.id);
        existingRequest.onsuccess = () => {
            const existing = existingRequest.result as StoryTheaterEntry | undefined;
            const countRequest = messages.index('charId').count(IDBKeyRange.only(threadId));
            countRequest.onsuccess = () => {
                if (!entry.cardOpeningConsumed && !existing?.cardOpeningConsumed && !entry.archives.length && !existing?.archives?.length && countRequest.result === 0) {
                    const message: Omit<Message, 'id'> = {
                        charId: threadId, role: 'assistant', type: 'text',
                        content: replaceStoryMacros(opening.content, userName, [opening.characterName]),
                        timestamp: Date.now(),
                        metadata: { source: 'story_theater', theaterId: entry.id, theaterCardOpening: true, theaterOpeningCharacterId: opening.characterId },
                    };
                    messages.add(message);
                }
                entries.put(saved);
            };
        };
        tx.oncomplete = () => resolve(saved);
        tx.onerror = () => reject(tx.error || new Error('剧情开场白保存失败'));
        tx.onabort = () => reject(tx.error || new Error('剧情开场白保存失败'));
    });
}
