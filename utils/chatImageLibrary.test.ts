import { describe, expect, it } from 'vitest';
import { DB } from './db';
import { getBlobForRef, putImageBlob } from './blobRef';
import { cleanupGeneratedChatImageBlobs, listGeneratedChatImages, removeGeneratedChatImage, removeGeneratedChatImages, saveGeneratedChatImage } from './chatImageLibrary';

describe('generated image library deletion', () => {
    it('removes the library record but preserves an image still referenced by chat', async () => {
        const imageRef = await putImageBlob(new Blob(['image'], { type: 'image/png' }));
        const record = await saveGeneratedChatImage({ characterId: 'image-library-test', provider: 'oai', requirement: '画面', prompt: '画面', imageRef });
        const messageId = await DB.saveMessage({ charId: 'image-library-test', role: 'assistant', type: 'image', content: imageRef });
        expect((await listGeneratedChatImages()).some(item => item.id === record.id)).toBe(true);
        await removeGeneratedChatImage(record);
        expect((await listGeneratedChatImages()).some(item => item.id === record.id)).toBe(false);
        expect(await getBlobForRef(imageRef)).not.toBeNull();
        await DB.deleteMessage(messageId);
    });

    it('removes an unreferenced image and exposes older records through pagination', async () => {
        const firstRef = await putImageBlob(new Blob(['first'], { type: 'image/png' }));
        const secondRef = await putImageBlob(new Blob(['second'], { type: 'image/png' }));
        const first = await saveGeneratedChatImage({ characterId: 'image-library-test', provider: 'oai', requirement: '', prompt: 'first', imageRef: firstRef });
        const second = await saveGeneratedChatImage({ characterId: 'image-library-test', provider: 'oai', requirement: '', prompt: 'second', imageRef: secondRef });
        const records = await listGeneratedChatImages(undefined, 100);
        const newest = records.find(item => item.id === first.id || item.id === second.id)!;
        const older = newest.id === first.id ? second : first;
        expect((await listGeneratedChatImages(newest.id, 100)).some(item => item.id === older.id)).toBe(true);
        await removeGeneratedChatImage(first);
        await removeGeneratedChatImage(second);
        expect(await getBlobForRef(firstRef)).toBeNull();
        expect(await getBlobForRef(secondRef)).toBeNull();
    });

    it('deletes selected records in bulk, including records beyond the first page, while preserving shared images', async () => {
        const sharedRef = await putImageBlob(new Blob(['shared'], { type: 'image/png' }));
        const orphanRef = await putImageBlob(new Blob(['orphan'], { type: 'image/png' }));
        const messageId = await DB.saveMessage({ charId: 'image-library-bulk', role: 'assistant', type: 'image', content: sharedRef });
        const records = [];
        for (let i = 0; i < 10; i++) records.push(await saveGeneratedChatImage({ characterId: 'image-library-bulk', provider: 'oai', requirement: '', prompt: String(i), imageRef: i === 0 ? sharedRef : orphanRef }));
        await DB.saveAssetRaw('unrelated-image-test', { imageRef: 'untouched' });
        const removed = await removeGeneratedChatImages([...records.map(record => record.id), records[0].id, 'unrelated-image-test']);
        expect(removed).toHaveLength(10);
        expect((await listGeneratedChatImages(undefined, 100)).filter(item => item.characterId === 'image-library-bulk')).toHaveLength(0);
        expect(await DB.getAsset('unrelated-image-test')).toBeDefined();
        expect(await getBlobForRef(orphanRef)).not.toBeNull();
        await cleanupGeneratedChatImageBlobs(removed);
        expect(await getBlobForRef(sharedRef)).not.toBeNull();
        expect(await getBlobForRef(orphanRef)).toBeNull();
        await DB.deleteMessage(messageId);
        await DB.deleteAsset('unrelated-image-test');
    });
});
