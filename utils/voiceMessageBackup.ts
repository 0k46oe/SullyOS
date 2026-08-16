/**
 * Voice favorites live in IndexedDB's generic `assets` store as a lightweight
 * metadata index plus one raw Blob asset per favorite.
 * JSON.stringify(Blob) produces `{}`, so the normal JSON backup shards cannot
 * carry the audio bytes by themselves. Full/media backups externalize those
 * Blobs into ZIP entries and leave a small, JSON-safe marker in the asset row.
 * Ordinary speech keeps the existing local behavior and is not copied into
 * portable backups; only explicit favorites are treated as archive items.
 */

import { VOICE_FAVORITE_AUDIO_PREFIX, VOICE_FAVORITES_INDEX_ASSET_ID } from './voiceFavorites';

export const VOICE_MESSAGE_ASSET_PREFIX = 'voice_msg_';
export const VOICE_BACKUP_DIR = 'assets/voice-favorites';
const LEGACY_VOICE_BACKUP_DIR = 'assets/chat-voices';
export const VOICE_BACKUP_MARKER = '__sullyChatVoiceBlobV1';

export interface VoiceBackupBlobMarker {
    [VOICE_BACKUP_MARKER]: true;
    path: string;
    mimeType: string;
    size: number;
}

type AssetRecord = {
    id?: unknown;
    data?: {
        blob?: unknown;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};

type WriteBinaryFile = (path: string, bytes: Uint8Array) => void | Promise<void>;
type ReadBinaryFile = (path: string) => Promise<Uint8Array | null>;

const isVoiceAsset = (asset: AssetRecord): asset is AssetRecord & { id: string } => {
    if (typeof asset?.id !== 'string') return false;
    if (asset.id.startsWith(VOICE_FAVORITE_AUDIO_PREFIX)) return true;
    return asset.id.startsWith(VOICE_MESSAGE_ASSET_PREFIX) && asset.data?.favorite === true;
};

const isRestorableVoiceAsset = (asset: AssetRecord): asset is AssetRecord & { id: string } => (
    typeof asset?.id === 'string'
    && (asset.id.startsWith(VOICE_FAVORITE_AUDIO_PREFIX) || asset.id.startsWith(VOICE_MESSAGE_ASSET_PREFIX))
);

/**
 * Portable backups omit reproducible TTS cache rows and ordinary per-message
 * voice rows. The favorites index and its dedicated audio rows pass through.
 */
export const shouldIncludeVoiceRelatedAssetInBackup = (value: unknown, includeFavorites = true): boolean => {
    const asset = value as AssetRecord | null | undefined;
    if (!asset || typeof asset.id !== 'string') return true;
    if (asset.id.startsWith('tts_')) return false;
    if (asset.id === VOICE_FAVORITES_INDEX_ASSET_ID || asset.id.startsWith(VOICE_FAVORITE_AUDIO_PREFIX)) return includeFavorites;
    if (asset.id.startsWith(VOICE_MESSAGE_ASSET_PREFIX)) return includeFavorites && asset.data?.favorite === true;
    return true;
};

export const isVoiceBackupBlobMarker = (value: unknown): value is VoiceBackupBlobMarker => {
    if (!value || typeof value !== 'object') return false;
    const marker = value as Partial<VoiceBackupBlobMarker>;
    return marker[VOICE_BACKUP_MARKER] === true
        && typeof marker.path === 'string'
        && (marker.path.startsWith(`${VOICE_BACKUP_DIR}/`) || marker.path.startsWith(`${LEGACY_VOICE_BACKUP_DIR}/`))
        && typeof marker.mimeType === 'string'
        && Number.isSafeInteger(marker.size)
        && (marker.size as number) >= 0;
};

const safeVoiceFilename = (id: string, index: number): string => {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || `voice_${index}`;
    return `${safeId}_${index}.bin`;
};

/**
 * Mutates the export clone in place. Dedicated favorite audio rows (plus the
 * legacy per-chat favorite shape) are externalized; shared `tts_*` entries are
 * reproducible cache and backing them up would duplicate ordinary audio.
 */
export async function externalizeVoiceMessageBlobs(
    assets: unknown,
    writeFile: WriteBinaryFile,
): Promise<number> {
    if (!Array.isArray(assets)) return 0;

    let written = 0;
    for (let index = 0; index < assets.length; index++) {
        const asset = assets[index] as AssetRecord;
        if (!isVoiceAsset(asset) || !asset.data || !(asset.data.blob instanceof Blob)) continue;

        const blob = asset.data.blob;
        const path = `${VOICE_BACKUP_DIR}/${safeVoiceFilename(asset.id, index)}`;
        await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
        asset.data.blob = {
            [VOICE_BACKUP_MARKER]: true,
            path,
            mimeType: blob.type || 'audio/mpeg',
            size: blob.size,
        } satisfies VoiceBackupBlobMarker;
        written++;
    }
    return written;
}

/** Restore ZIP-backed markers to real Blobs before IndexedDB import begins. */
export async function restoreVoiceMessageBlobs(
    assets: unknown,
    readFile: ReadBinaryFile,
): Promise<number> {
    if (!Array.isArray(assets)) return 0;

    let restored = 0;
    for (const raw of assets) {
        const asset = raw as AssetRecord;
        if (!isRestorableVoiceAsset(asset) || !asset.data || !isVoiceBackupBlobMarker(asset.data.blob)) continue;

        const marker = asset.data.blob;
        const bytes = await readFile(marker.path);
        if (!bytes) {
            throw new Error(`损坏的备份包：缺少收藏语音文件 ${marker.path}，已中止导入（数据未改动）。`);
        }
        if (bytes.byteLength !== marker.size) {
            throw new Error(`损坏的备份包：收藏语音文件 ${marker.path} 大小不符，已中止导入（数据未改动）。`);
        }
        // Copy into a fresh ArrayBuffer: TS 5.7 models an arbitrary Uint8Array's
        // backing store as ArrayBufferLike (possibly SharedArrayBuffer), while
        // BlobPart deliberately accepts only ordinary ArrayBuffer views.
        const ownedBytes = new Uint8Array(bytes.byteLength);
        ownedBytes.set(bytes);
        asset.data.blob = new Blob([ownedBytes.buffer], { type: marker.mimeType || 'audio/mpeg' });
        restored++;
    }
    return restored;
}
