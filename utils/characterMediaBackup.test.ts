import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { openCharacterMediaBackup, importCharacterMedia } from './characterMediaBackup';
import { DB } from './db';
import { getBlobForRef } from './blobRef';
import { VOICE_BACKUP_MARKER } from './voiceMessageBackup';
import { VOICE_FAVORITES_INDEX_ASSET_ID, getVoiceFavoriteBlob, listVoiceFavorites, makeVoiceFavoriteId, saveVoiceFavorite, voiceFavoriteAudioAssetId } from './voiceFavorites';

const favorite = (charId: string, sourceKey: string) => ({
    id: makeVoiceFavoriteId('chat', sourceKey), source: 'chat' as const, sourceKey, charId,
    charName: charId, sourceTimestamp: 100, favoritedAt: 200, originalText: 'voice',
});
const image = (id: string, charId: string, url: string, timestamp = 100) => ({ id, charId, url, timestamp });
const imageData = (base64: string) => `data:image/png;base64,${base64}`;
const audio = (path: string, size: number) => ({ blob: { [VOICE_BACKUP_MARKER]: true, path, size, mimeType: 'audio/mpeg' } });
const file = async (zip: JSZip) => new File([await zip.generateAsync({ type: 'arraybuffer' })], 'backup.zip');

async function legacyZip() {
    const zip = new JSZip();
    const indexed = favorite('old', 'old:100');
    const other = favorite('other', 'other:200');
    zip.file('data.json', JSON.stringify({
        characters: [{ id: 'old', name: 'Old Role' }, { id: 'other', name: 'Other Role' }],
        galleryImages: [image('missing-photo', 'old', 'assets/restore.png'), image('conflict-photo', 'old', imageData('YXNk')), image('other-photo', 'other', imageData('dHdv'))],
        assets: [
            { id: VOICE_FAVORITES_INDEX_ASSET_ID, data: { version: 1, items: [indexed, other] } },
            { id: voiceFavoriteAudioAssetId(indexed.id), data: audio('assets/voice-favorites/selected.bin', 5) },
            { id: voiceFavoriteAudioAssetId(other.id), data: audio('assets/voice-favorites/other.bin', 5) },
            { id: 'voice_msg_101', data: { ...audio('assets/chat-voices/legacy.bin', 6), favorite: true } },
            { id: 'voice_msg_102', data: audio('assets/chat-voices/legacy.bin', 6) },
        ],
        messages: [{ id: 101, charId: 'old', timestamp: 250 }, { id: 102, charId: 'old', timestamp: 300 }],
    }));
    zip.file('assets/restore.png', 'restored');
    zip.file('assets/voice-favorites/selected.bin', 'audio');
    zip.file('assets/voice-favorites/other.bin', 'other');
    zip.file('assets/chat-voices/legacy.bin', 'legacy');
    return zip;
}

describe('restore one character’s media', () => {
    it('finds roles in an old ZIP, repairs lost media, and preserves current entries on repeated import', async () => {
        await DB.saveCharacter({ id: 'target', name: 'Target' } as any);
        await DB.saveGalleryImage(image('missing-photo', 'target', 'blobref:missing'));
        await DB.saveGalleryImage(image('conflict-photo', 'target', imageData('bmV3'), 99));
        const kept = await saveVoiceFavorite({ ...favorite('target', 'target:999'), blob: new Blob(['keep']) });
        const occupied = await saveVoiceFavorite({ ...favorite('other', 'old:100'), blob: new Blob(['untouched']) });
        const archive = await openCharacterMediaBackup([await file(await legacyZip())]);
        try {
            const source = archive.characters.find(role => role.name === 'Old Role')!;
            expect(archive.characters.map(role => role.name)).toEqual(['Old Role', 'Other Role']);
            expect(source.voices.map(entry => entry.favorite.sourceKey)).toEqual(['old:101', 'old:100']);
            expect(await importCharacterMedia(archive, source, 'target')).toEqual({ photos: 2, voices: 2, skipped: 0 });
            expect(await importCharacterMedia(archive, source, 'target')).toEqual({ photos: 0, voices: 0, skipped: 4 });
            const photos = await DB.getGalleryImages('target');
            expect(photos).toHaveLength(3);
            expect(photos.find(photo => photo.id === 'conflict-photo')?.url).toEqual(imageData('bmV3'));
            const repaired = photos.find(photo => photo.id === 'missing-photo')!;
            expect(await (await getBlobForRef(repaired.url))?.text()).toEqual('restored');
            const voices = await listVoiceFavorites();
            expect(voices.filter(voice => voice.charId === 'target')).toHaveLength(3);
            expect(await (await getVoiceFavoriteBlob(kept.id))?.text()).toEqual('keep');
            expect(await (await getVoiceFavoriteBlob(occupied.id))?.text()).toEqual('untouched');
            expect(await Promise.all(voices.filter(voice => voice.charId === 'target').map(async voice => (await getVoiceFavoriteBlob(voice.id))?.text()))).toEqual(expect.arrayContaining(['legacy', 'audio', 'keep']));
        } finally { await archive.close(); }
    });

    it('reads v3 sharded photos and leaves the album unchanged when selected audio is corrupt', async () => {
        const selected = favorite('v3', 'v3:1');
        const zip = new JSZip();
        zip.file('manifest.json', JSON.stringify({ formatVersion: 3, stores: Object.fromEntries(['characters', 'galleryImages', 'assets'].map((store, i) => [store, { parts: 1, count: i === 2 ? 2 : 1 }])) }));
        zip.file('metadata.json', '{}');
        zip.file('stores/characters.000.json', JSON.stringify([{ id: 'v3', name: 'V3 role' }]));
        zip.file('stores/galleryImages.000.json', JSON.stringify([image('v3-photo', 'v3', 'blobref:fixture')]));
        zip.file('stores/assets.000.json', JSON.stringify([
            { id: VOICE_FAVORITES_INDEX_ASSET_ID, data: { version: 1, items: [selected] } },
            { id: voiceFavoriteAudioAssetId(selected.id), data: audio('assets/voice-favorites/corrupt.bin', 10) },
        ]));
        zip.file('blobs/index.json', JSON.stringify([{ id: 'fixture', type: 'image/png', size: 5 }]));
        zip.file('blobs/fixture', 'photo');
        zip.file('assets/voice-favorites/corrupt.bin', 'short');
        const archive = await openCharacterMediaBackup([await file(zip)]);
        try {
            await DB.saveCharacter({ id: 'corrupt-target', name: 'Corrupt target' } as any);
            const role = archive.characters[0];
            expect(await (await archive.photo(role.photos[0]) as Blob).text()).toEqual('photo');
            await expect(importCharacterMedia(archive, role, 'corrupt-target')).rejects.toThrow('素材文件大小不符');
            expect(await DB.getGalleryImages('corrupt-target')).toEqual([]);
        } finally { await archive.close(); }
    });
});
