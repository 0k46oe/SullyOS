import { describe, expect, it } from 'vitest';
import { DB } from './db';
import { getBlobForRef, putImageBlob } from './blobRef';
import { listGeneratedChatImages, removeGeneratedChatImage, saveGeneratedChatImage } from './chatImageLibrary';

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
});
