import { assertSupportedSullyBackup } from './backupImportPolicy';
import { blobEntryPath, BLOBS_INDEX_FILE, type BackupBlobIndexEntry } from './backupBlobs';
import { shardFileName, SUPPORTED_IMPORT_FORMAT_VERSIONS, type BackupManifest, type ZipFileReader } from './backupFormat';
import { validateVolumeFiles } from './backupVolumes';
import { dataUrlToBlob, getBlobForRef, isBlobRef, putImageBlobDeduped } from './blobRef';
import { DB } from './db';
import { withSharedAssetLock } from './sharedAssetLock';
import { mergeCharacterMedia, makeVoiceFavoriteId, readVoiceFavoriteIndex, voiceFavoriteAudioAssetId, VOICE_FAVORITES_INDEX_ASSET_ID, type VoiceFavorite } from './voiceFavorites';
import { isVoiceBackupBlobMarker, VOICE_MESSAGE_ASSET_PREFIX } from './voiceMessageBackup';
import type { GalleryImage } from '../types';

type MediaFile = { path: string; type: string; size?: number };
type AlbumEntry = { image: GalleryImage; media: string | MediaFile | null };
type VoiceEntry = { favorite: VoiceFavorite; media: MediaFile | null };
export type BackupMediaCharacter = {
    key: string;
    id: string;
    name: string;
    space?: string;
    spaceId?: string;
    photos: AlbumEntry[];
    voices: VoiceEntry[];
};

const imageTypes: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', ico: 'image/x-icon', apng: 'image/apng' };
const isRemoteImage = (value: string) => /^https?:\/\/[^\s]+$/i.test(value);
const sharedFile = (value: unknown) => typeof value === 'string' && /^shared\/[a-zA-Z0-9_-]+\.bin$/.test(value);

export async function openCharacterMediaBackup(files: File[]) {
    const index = files.find(file => /\.sullyindex\.json$/i.test(file.name));
    const single = files.length === 1 ? files[0] : undefined;
    const json = !index && single && /\.json$/i.test(single.name) ? single : undefined;
    const zipBlob = index ? await validateVolumeFiles(index, files) : single && /\.zip$/i.test(single.name) ? single : undefined;
    if (!zipBlob && !json) throw new Error('请选择一份 ZIP、JSON，或同一份备份的索引和全部分卷。');
    const zip = zipBlob ? await (await import('./backupZipReader')).openBackupZip(zipBlob) : undefined;
    try {
        const backup = await readCharacterMediaBackup(zip, json ? JSON.parse(await json.text()) : undefined);
        const pending = new Set<Promise<unknown>>();
        let closing: Promise<void> | undefined;
        const track = <Entry, Result>(read: (entry: Entry) => Promise<Result>) => async (entry: Entry) => {
            if (closing) throw new Error('备份已关闭，请重新选择文件');
            const operation = read(entry);
            pending.add(operation);
            try { return await operation; }
            finally { pending.delete(operation); }
        };
        return {
            ...backup, photo: track(backup.photo), voice: track(backup.voice),
            close: () => closing ??= Promise.allSettled(pending).then(async () => { await zip?.close(); }),
        };
    } catch (error) {
        await zip?.close();
        throw error;
    }
}

export async function readCharacterMediaBackup(zip?: ZipFileReader, json?: unknown) {
    const blobFiles = new Map<string, MediaFile>();
    const characters: BackupMediaCharacter[] = [];
    const hasFile = (path: string) => !!zip?.file(path);
    const readJson = async (path: string) => {
        const file = zip?.file(path);
        if (!file) throw new Error(`备份缺少 ${path}`);
        return JSON.parse(await file.async('string'));
    };
    async function* rows(paths: string[]): AsyncGenerator<any> {
        for (const path of paths) {
            const data = await readJson(path);
            if (!Array.isArray(data)) throw new Error(`备份分片格式有误（${path}）`);
            yield* data;
        }
    }
    function addBlobFile(id: string, file: MediaFile) {
        if (/^[a-zA-Z0-9_]+$/.test(id) && hasFile(file.path) && typeof file.type === 'string'
            && Number.isSafeInteger(file.size) && file.size! > 0) blobFiles.set(`blobref:${id}`, file);
    }
    function imageMedia(value: any): AlbumEntry['media'] {
        if (typeof value === 'string') {
            if (isBlobRef(value)) return blobFiles.get(value) ?? null;
            if (/^data:image\/[\w.+-]+[;,]/i.test(value) || isRemoteImage(value)) return value;
            if (value.startsWith('assets/') && hasFile(value)) {
                const type = imageTypes[value.split('.').at(-1)?.toLowerCase() ?? ''];
                return type ? { path: value, type } : null;
            }
        }
        if (sharedFile(value?.__spaceDataURL) && hasFile(value.__spaceDataURL) && /^image\//.test(value.type)) {
            return { path: value.__spaceDataURL, type: value.type };
        }
        return null;
    }
    function voiceMedia(value: any): MediaFile | null {
        if (isVoiceBackupBlobMarker(value) && value.size > 0 && hasFile(value.path)) {
            return { path: value.path, size: value.size, type: value.mimeType };
        }
        if (sharedFile(value?.__spaceBinary) && hasFile(value.__spaceBinary) && !value.arrayType) {
            return { path: value.__spaceBinary, type: typeof value.type === 'string' ? value.type : '' };
        }
        return null;
    }
    async function collect(profileRows: AsyncIterable<any> | any[], galleryRows: AsyncIterable<any> | any[], assetRows: AsyncIterable<any> | any[], messageRows: () => AsyncIterable<any> | any[], space?: { id: string; name: string }) {
        const byId = new Map<string, BackupMediaCharacter>();
        function character(id: string) {
            let value = byId.get(id);
            if (!value) {
                value = { key: JSON.stringify([space?.id, id]), id, name: '', space: space?.name, spaceId: space?.id, photos: [], voices: [] };
                byId.set(id, value);
            }
            return value;
        }
        for await (const row of profileRows) {
            if (typeof row?.id === 'string' && row.id) character(row.id).name = typeof row.name === 'string' ? row.name : '';
        }
        for await (const row of galleryRows) {
            if (typeof row?.id !== 'string' || !row.id || typeof row.charId !== 'string' || !row.charId) continue;
            const timestamp = typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? row.timestamp : 0;
            const image: GalleryImage = { id: row.id, charId: row.charId, url: '', timestamp };
            if (typeof row.review === 'string') image.review = row.review;
            if (Number.isFinite(row.reviewTimestamp)) image.reviewTimestamp = row.reviewTimestamp;
            if (typeof row.savedDate === 'string') image.savedDate = row.savedDate;
            if (Array.isArray(row.chatContext)) image.chatContext = row.chatContext.filter((line: unknown) => typeof line === 'string');
            character(row.charId).photos.push({ image, media: imageMedia(row.url) });
        }
        const audioFiles = new Map<string, MediaFile | null>();
        let favorites: VoiceFavorite[] = [];
        const legacyVoices = new Map<string, { originalText?: string; spokenText?: string; lang?: string; media: MediaFile | null }>();
        for await (const asset of assetRows) {
            if (asset?.id === VOICE_FAVORITES_INDEX_ASSET_ID) favorites = readVoiceFavoriteIndex(asset.data);
            else if (typeof asset?.id === 'string' && asset.id.startsWith(voiceFavoriteAudioAssetId(''))) {
                audioFiles.set(asset.id, voiceMedia(asset.data?.blob ?? asset.data));
            } else if (typeof asset?.id === 'string' && asset.id.startsWith(VOICE_MESSAGE_ASSET_PREFIX) && asset.data?.favorite === true) {
                legacyVoices.set(asset.id, { ...asset.data, media: voiceMedia(asset.data.blob) });
            }
        }
        for (const favorite of favorites) {
            const owner = character(favorite.charId);
            owner.name ||= favorite.charName;
            owner.voices.push({ favorite, media: audioFiles.get(voiceFavoriteAudioAssetId(favorite.id)) ?? null });
        }
        if (legacyVoices.size) {
            const indexedChatKeys = new Set(favorites.filter(favorite => favorite.source === 'chat').map(favorite => favorite.sourceKey));
            for await (const row of messageRows()) {
                if (typeof row?.id !== 'number' || typeof row.charId !== 'string' || !row.charId) continue;
                const legacy = legacyVoices.get(VOICE_MESSAGE_ASSET_PREFIX + row.id);
                if (!legacy) continue;
                const sourceKey = row.charId + ':' + row.id;
                if (indexedChatKeys.has(sourceKey)) continue;
                indexedChatKeys.add(sourceKey);
                const owner = character(row.charId);
                const timestamp = typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? row.timestamp : 0;
                owner.voices.push({ favorite: {
                    id: makeVoiceFavoriteId('chat', sourceKey), source: 'chat', sourceKey,
                    charId: owner.id, charName: owner.name || '未知角色', sourceTimestamp: timestamp, favoritedAt: timestamp,
                    originalText: typeof legacy.originalText === 'string' ? legacy.originalText : '',
                    spokenText: typeof legacy.spokenText === 'string' ? legacy.spokenText : undefined,
                    language: typeof legacy.lang === 'string' ? legacy.lang : undefined,
                }, media: legacy.media });
            }
        }
        for (const owner of byId.values()) {
            if (!owner.photos.length && !owner.voices.length) continue;
            owner.name ||= `角色 ${owner.id}`;
            owner.photos.sort((a, b) => b.image.timestamp - a.image.timestamp);
            owner.voices.sort((a, b) => b.favorite.sourceTimestamp - a.favorite.sourceTimestamp);
            characters.push(owner);
        }
    }

    if (hasFile('user-spaces.json')) {
        const manifest = await readJson('user-spaces.json');
        if (manifest?.format !== 'sully-user-spaces' || manifest.version !== 1 || !Array.isArray(manifest.spaces)) throw new Error('用户空间备份格式无效');
        for (const entry of manifest.blobs ?? []) if (entry && sharedFile(entry.path)) addBlobFile(entry.id, entry);
        for (const space of manifest.spaces) {
            if (typeof space?.id !== 'string' || typeof space.name !== 'string' || !space.stores) throw new Error('用户空间目录无效');
            const store = (name: string) => {
                const paths = space.stores[name] ?? [];
                if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path.startsWith(`spaces/${space.id}/${name}.`) || !/^spaces\/[\w-]+\/\w+\.\d+\.json$/.test(path))) throw new Error('用户空间分片目录无效');
                return rows(paths);
            };
            await collect(store('characters'), store('gallery'), store('assets'), () => store('messages'), space);
        }
    } else if (hasFile('manifest.json')) {
        const manifest: BackupManifest = await readJson('manifest.json');
        if (!SUPPORTED_IMPORT_FORMAT_VERSIONS.includes(manifest?.formatVersion)) throw new Error('此备份版本暂不支持');
        assertSupportedSullyBackup(await readJson('metadata.json'));
        if (hasFile(BLOBS_INDEX_FILE)) {
            const entries: BackupBlobIndexEntry[] = await readJson(BLOBS_INDEX_FILE);
            if (!Array.isArray(entries)) throw new Error('图片文件目录无效');
            for (const entry of entries) if (entry) addBlobFile(entry.id, { ...entry, path: blobEntryPath(entry.id) });
        }
        async function* store(field: string) {
            const spec = manifest.stores?.[field];
            if (!spec) return;
            if (!Number.isSafeInteger(spec.parts) || spec.parts < 0 || !Number.isSafeInteger(spec.count) || spec.count < 0) throw new Error('备份分片数量无效');
            let count = 0;
            for (let part = 0; part < spec.parts; part++) {
                for await (const row of rows([shardFileName(field, part)])) {
                    count++;
                    yield row;
                }
            }
            if (count !== spec.count) throw new Error(`备份分片条数不符（${field}）`);
        }
        await collect(store('characters'), store('galleryImages'), store('assets'), () => store('messages'));
    } else {
        const root = zip ? await readJson('data.json') : json;
        assertSupportedSullyBackup(root);
        const array = (value: unknown) => Array.isArray(value) ? value : [];
        await collect(array(root.characters), array(root.galleryImages), array(root.assets), () => array(root.messages));
    }

    async function load(media: MediaFile): Promise<Blob> {
        const bytes = await zip!.file(media.path)!.async('uint8array');
        if (!bytes.byteLength || (media.size !== undefined && bytes.byteLength !== media.size)) throw new Error(`素材文件大小不符（${media.path}）`);
        return new Blob([bytes.slice().buffer as ArrayBuffer], { type: media.type });
    }
    const photo = async (entry: AlbumEntry) => {
        if (typeof entry.media === 'string') return isRemoteImage(entry.media) ? entry.media : dataUrlToBlob(entry.media);
        return entry.media ? load(entry.media) : null;
    };
    const voice = (entry: VoiceEntry) => entry.media ? load(entry.media) : Promise.resolve(null);
    return { characters, photo, voice };
}

export type CharacterMediaBackup = Awaited<ReturnType<typeof readCharacterMediaBackup>>;

export async function importCharacterMedia(backup: CharacterMediaBackup, source: BackupMediaCharacter, targetId: string) {
    if (!backup.characters.includes(source)) throw new Error('请选择备份里的来源角色');
    const target = await DB.getCharacter(targetId);
    if (!target) throw new Error('当前用户空间里找不到所选角色');
    return withSharedAssetLock('shared', async () => {
        const current = new Map((await DB.getGalleryImages(targetId)).map(image => [image.id, image]));
        const photos = [];
        const voices = [];
        for (const entry of source.photos) {
            if (!entry.media) continue;
            const fallbackId = `album-import:${JSON.stringify([targetId, source.spaceId ?? '', source.id, entry.image.id])}`;
            const original = current.get(entry.image.id);
            const existing = current.get(fallbackId) ?? (original?.timestamp === entry.image.timestamp ? original : undefined);
            const existingUrl = existing?.url ?? '';
            if (existing && (isBlobRef(existingUrl) ? (await getBlobForRef(existingUrl))?.size : /^data:image\//i.test(existingUrl) || isRemoteImage(existingUrl))) continue;
            const media = await backup.photo(entry);
            if (!media || (media instanceof Blob && !media.size)) throw new Error('备份中的图片文件为空');
            const url = typeof media === 'string' ? media : (await putImageBlobDeduped(media)).token;
            photos.push({ image: { ...entry.image, charId: targetId, url }, fallbackId, repair: existing ? { id: existing.id, url: existingUrl } : undefined });
        }
        for (const entry of source.voices) {
            if (!entry.media) continue;
            const blob = await backup.voice(entry);
            if (!blob?.size) throw new Error('备份中的收藏语音文件为空');
            const favorite = { ...entry.favorite, charId: targetId, charName: target.name };
            // Keep the original identity when it belongs to this role, and isolate unrelated collisions.
            const sourceKey = `voice-import:${JSON.stringify([targetId, source.spaceId ?? '', source.id, favorite.sourceKey])}`;
            const fallback = { ...favorite, id: makeVoiceFavoriteId(favorite.source, sourceKey), sourceKey };
            voices.push({ favorite, fallback, blob });
        }
        const result = await mergeCharacterMedia(targetId, photos, voices);
        return { ...result, skipped: source.photos.length + source.voices.length - result.photos - result.voices };
    });
}
