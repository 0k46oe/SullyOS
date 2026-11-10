import { describe, expect, it } from 'vitest';
import { DB } from './db';
import { listGeneratedChatImages, removeGeneratedChatImage, savePendingAutomaticImage } from './chatImageLibrary';

describe('recovering an automatic image gallery save', () => {
    it('recovers after interruption without duplicate records and respects later deletion', async () => {
        const id = await DB.saveMessage({ charId: 'recovery-test', role: 'assistant', type: 'image', content: 'image-ref', metadata: { generatedImageGalleryState: 'pending', generatedImageProvider: 'oai', generatedImagePrompt: '画面' } });
        expect((await DB.getMessageById(id))?.metadata.generatedImageGalleryState).toBe('pending');
        expect(await Promise.all([savePendingAutomaticImage(id), savePendingAutomaticImage(id)])).toEqual(['saved', 'saved']);
        const rows = (await listGeneratedChatImages(undefined, 100)).filter(row => row.characterId === 'recovery-test');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ imageRef: 'image-ref', prompt: '画面' });
        expect((await DB.getMessageById(id))?.metadata.generatedImageGalleryState).toBe('saved');
        await removeGeneratedChatImage(rows[0]);
        await savePendingAutomaticImage(id);
        expect((await listGeneratedChatImages(undefined, 100)).filter(row => row.characterId === 'recovery-test')).toHaveLength(0);
        await DB.deleteMessage(id);
    });
    it('does not recreate a deleted message', async () => {
        const id = await DB.saveMessage({ charId: 'recovery-deleted', role: 'assistant', type: 'image', content: 'image-ref', metadata: { generatedImageGalleryState: 'pending', generatedImageProvider: 'oai' } });
        await DB.deleteMessage(id);
        expect(await savePendingAutomaticImage(id)).toBe('missing');
        expect((await listGeneratedChatImages(undefined, 100)).some(row => row.characterId === 'recovery-deleted')).toBe(false);
    });
});
