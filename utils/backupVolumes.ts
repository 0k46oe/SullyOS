export interface BackupVolumePart { name: string; size: number; sha256: string }
export interface BackupVolumeIndex { format: 'sully-backup-volumes'; version: 1; id: string; mode: string; parts: BackupVolumePart[]; totalSize: number }
export interface BackupVolumeOutput { blob: Blob; name: string; index: number }
export const BACKUP_VOLUME_BYTES = 16 * 1024 * 1024;
export async function backupDigest(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    return [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function createVolumeCollector(id: string, mode: string, onPart: (part: BackupVolumeOutput) => Promise<void>, limit = BACKUP_VOLUME_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('备份分卷大小无效');
    let pieces: Blob[] = [], bytes = 0;
    const parts: BackupVolumePart[] = [];
    const emit = async () => {
        if (!bytes) return;
        const blob = new Blob(pieces, { type: 'application/octet-stream' });
        pieces = []; bytes = 0;
        const name = `Sully_${id}_${String(parts.length + 1).padStart(4, '0')}.sullypart`;
        const part = { name, size: blob.size, sha256: await backupDigest(blob) };
        await onPart({ blob, name, index: parts.length + 1 });
        parts.push(part);
    };
    return {
        async write(chunk: Uint8Array) {
            for (let offset = 0; offset < chunk.byteLength;) {
                const size = Math.min(limit - bytes, chunk.byteLength - offset);
                pieces.push(new Blob([chunk.slice(offset, offset + size)])); bytes += size; offset += size;
                if (bytes === limit) await emit();
            }
        },
        async finish(): Promise<Blob> {
            await emit();
            const index: BackupVolumeIndex = { format: 'sully-backup-volumes', version: 1, id, mode, parts, totalSize: parts.reduce((sum, p) => sum + p.size, 0) };
            return new Blob([JSON.stringify(index)], { type: 'application/json' });
        },
    };
}

/** Files stay file-backed; concatenating Blobs does not read the complete archive
 * into a JS ArrayBuffer. The ZIP reader below requests bounded ranges. */
export async function validateVolumeFiles(indexFile: File, files: readonly File[]): Promise<Blob> {
    if (indexFile.size > 4 * 1024 * 1024) throw new Error('分卷索引过大');
    const index = JSON.parse(await indexFile.text()) as BackupVolumeIndex;
    if (index.format !== 'sully-backup-volumes' || index.version !== 1 || !Array.isArray(index.parts) || !index.parts.length) throw new Error('分卷索引格式无效');
    const byName = new Map<string, File>();
    for (const file of files) { if (byName.has(file.name)) throw new Error(`选择了重复文件：${file.name}`); byName.set(file.name, file); }
    const pieces: File[] = [], names = new Set<string>();
    for (const part of index.parts) {
        if (!part || typeof part.name !== 'string' || !/^[\w.-]+\.sullypart$/.test(part.name) || names.has(part.name) || !Number.isSafeInteger(part.size) || part.size <= 0 || part.size > BACKUP_VOLUME_BYTES || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error('分卷索引条目无效');
        names.add(part.name);
        const file = byName.get(part.name);
        if (!file) throw new Error(`缺少分卷 ${part.name}，数据尚未改动`);
        if (file.size !== part.size || await backupDigest(file) !== part.sha256) throw new Error(`分卷 ${part.name} 已损坏，数据尚未改动`);
        pieces.push(file);
    }
    if (pieces.reduce((n, p) => n + p.size, 0) !== index.totalSize) throw new Error('分卷总大小不符');
    return new Blob(pieces, { type: 'application/zip' });
}

export interface CachedBackupSet { id: string; files: Array<{ name: string; size: number }>; createdAt: number; complete?: boolean }
async function cacheDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('sully-backup-export-cache-v1', 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('files', { keyPath: 'name' }); request.result.createObjectStore('sets', { keyPath: 'id' }); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
}
async function cacheRequest<T>(store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await cacheDB();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction(store, mode); const request = run(tx.objectStore(store));
            tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
    } finally { db.close(); }
}
export async function cacheBackupVolume(id: string, part: BackupVolumeOutput) {
    const db = await cacheDB();
    try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['files', 'sets'], 'readwrite');
        tx.objectStore('files').put({ id, name: part.name, blob: part.blob });
        const sets = tx.objectStore('sets'); const request = sets.get(id);
        request.onsuccess = () => {
            const set: CachedBackupSet = request.result || { id, files: [], createdAt: Date.now(), complete: false };
            set.files = set.files.filter(file => file.name !== part.name);
            set.files.push({ name: part.name, size: part.blob.size });
            sets.put(set);
        };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
}
export async function finishCachedBackupSet(set: CachedBackupSet) { await cacheRequest('sets', 'readwrite', store => store.put({ ...set, complete: true })); }
export async function listCachedBackupSets(): Promise<CachedBackupSet[]> { return cacheRequest('sets', 'readonly', store => store.getAll()); }
export async function readCachedBackupFile(name: string): Promise<Blob> {
    const row: any = await cacheRequest('files', 'readonly', store => store.get(name));
    if (!row?.blob) throw new Error('临时备份文件不存在，请重新导出');
    return row.blob;
}
export async function deleteCachedBackupSet(id: string): Promise<void> {
    const db = await cacheDB();
    try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['files', 'sets'], 'readwrite');
        tx.objectStore('sets').delete(id);
        const store = tx.objectStore('files'); const request = store.openCursor();
        request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (cursor.value.id === id) cursor.delete(); cursor.continue(); };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
}
