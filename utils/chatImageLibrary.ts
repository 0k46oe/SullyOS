import { DB, openDB } from './db';
import { deleteBlobRefIfUnreferenced, getBlobForRef, putImageBlob } from './blobRef';
import type { ImageGenerationProvider } from '../types';

const PREFIX = 'chat_generated_image:';
export interface GeneratedChatImage {
    id: string; createdAt: number; characterId: string; provider: ImageGenerationProvider;
    requirement: string; prompt: string; imageRef: string; thumbnailRef?: string; generatedImageFailed?: boolean;
}
export async function listGeneratedChatImages(before?: string, limit = 12): Promise<GeneratedChatImage[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const rows: GeneratedChatImage[] = [];
        const tx = db.transaction('assets', 'readonly');
        const range = IDBKeyRange.bound(PREFIX, before || PREFIX + '\uffff', false, !!before);
        const cursor = tx.objectStore('assets').openCursor(range, 'prev');
        cursor.onsuccess = () => { const item = cursor.result; if (!item || rows.length >= limit) return; rows.push(item.value.data); item.continue(); };
        tx.oncomplete = () => resolve(rows);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('生图记录读取失败'));
    });
}
async function makeThumbnail(imageRef: string): Promise<string | undefined> {
    const blob = await getBlobForRef(imageRef);
    if (!blob || typeof document === 'undefined') return;
    const url = URL.createObjectURL(blob);
    try {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        const thumb = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.78));
        return thumb ? putImageBlob(thumb) : undefined;
    } finally { URL.revokeObjectURL(url); }
}
export async function saveGeneratedChatImage(record: Omit<GeneratedChatImage, 'id' | 'createdAt' | 'thumbnailRef'>, options: { skipThumbnail?: boolean } = {}): Promise<GeneratedChatImage> {
    const createdAt = Date.now();
    const saved: GeneratedChatImage = { ...record, id: PREFIX + createdAt + ':' + crypto.randomUUID(), createdAt };
    // Persist the original first: a thumbnail failure must not lose a paid result.
    await DB.saveAssetRaw(saved.id, saved);
    if (options.skipThumbnail) return saved;
    try { saved.thumbnailRef = await makeThumbnail(saved.imageRef); if (saved.thumbnailRef) await DB.saveAssetRaw(saved.id, saved); } catch { /* Original remains available. */ }
    return saved;
}
/** Complete a pending automatic-image save atomically with its message marker.
 * Reopening a chat can safely retry this without creating duplicates or reviving deletions. */
export async function savePendingAutomaticImage(messageId: number): Promise<'saved' | 'missing'> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['messages', 'assets'], 'readwrite');
        const messages = tx.objectStore('messages');
        let outcome: 'saved' | 'missing' = 'missing';
        const request = messages.get(messageId);
        request.onsuccess = () => {
            const message = request.result;
            if (!message) return;
            const metadata = message.metadata || {};
            if (metadata.generatedImageGalleryState === 'saved') { outcome = 'saved'; return; }
            if (metadata.generatedImageGalleryState !== 'pending' || !['oai', 'nai'].includes(metadata.generatedImageProvider) || !message.content) return;
            const id = PREFIX + message.timestamp + ':message-' + messageId;
            const record: GeneratedChatImage = {
                id, createdAt: message.timestamp, characterId: message.charId,
                provider: metadata.generatedImageProvider, requirement: metadata.generatedImagePrompt || '',
                prompt: metadata.generatedImagePrompt || '', imageRef: message.content,
                generatedImageFailed: metadata.generatedImageFailed === true,
            };
            tx.objectStore('assets').put({ id, data: record });
            messages.put({ ...message, metadata: { ...metadata, generatedImageGalleryState: 'saved' } });
            outcome = 'saved';
        };
        tx.oncomplete = () => resolve(outcome);
        tx.onerror = () => reject(tx.error || new Error('生图库保存失败'));
        tx.onabort = () => reject(tx.error || new Error('生图库保存失败'));
    });
}
export async function removeGeneratedChatImage(record: GeneratedChatImage): Promise<void> {
    await DB.deleteAsset(record.id);
    await deleteBlobRefIfUnreferenced(record.imageRef);
    await deleteBlobRefIfUnreferenced(record.thumbnailRef);
}
export async function removeGeneratedChatImages(ids: string[]): Promise<GeneratedChatImage[]> {
    const keys = Array.from(new Set(ids)).filter(id => id.startsWith(PREFIX));
    if (!keys.length) return [];
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const removed: GeneratedChatImage[] = [];
        const tx = db.transaction('assets', 'readwrite');
        const store = tx.objectStore('assets');
        for (const id of keys) {
            const request = store.get(id);
            request.onsuccess = () => {
                if (request.result?.data) { removed.push(request.result.data); store.delete(id); }
            };
        }
        tx.oncomplete = () => resolve(removed);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('生图记录删除失败'));
    });
}
export async function cleanupGeneratedChatImageBlobs(records: GeneratedChatImage[]): Promise<void> {
    const refs = new Set(records.flatMap(record => [record.imageRef, record.thumbnailRef]).filter((ref): ref is string => !!ref));
    for (const ref of refs) await deleteBlobRefIfUnreferenced(ref);
}
/** A persisted claim prevents inbox replay from issuing the same paid request twice. */
export async function claimAutomaticImage(key: string): Promise<boolean> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readwrite'), store = tx.objectStore('assets');
        const id = 'chat_image_job:' + key; let claimed = false;
        const req = store.get(id);
        req.onsuccess = () => { if (!req.result) { store.put({ id, data: { startedAt: Date.now() } }); claimed = true; } };
        tx.oncomplete = () => resolve(claimed);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('生图任务保存失败'));
    });
}
