import type { ZipFileWriter } from './backupFormat';
import { createVolumeCollector, type BackupVolumeOutput } from './backupVolumes';

type FileOptions = Parameters<ZipFileWriter['file']>[2];
const OUTPUT_PART_BYTES = 1024 * 1024;

/** Compress queued browser-owned Blobs during each export checkpoint.
 * The final archive is composed of Blob parts, never concatenated into one huge
 * Uint8Array. Blob storage still costs memory/disk; this bounds JS byte buffers,
 * not total browser memory. The ZIP contents remain readable by old importers. */
export interface BackupArchiveOptions { volumeId?: string; mode?: string; volumeBytes?: number; onVolume?: (part: BackupVolumeOutput) => Promise<void> }
export function createBackupArchive(options: BackupArchiveOptions = {}) {
    const entries = new Map<string, { blob: Blob; options?: FileOptions }>();
    let started = false;
    let writer: any;
    let writing: Promise<void> = Promise.resolve();
    const parts: Blob[] = [];
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const collector = options.onVolume ? createVolumeCollector(options.volumeId!, options.mode || 'full', options.onVolume, options.volumeBytes) : undefined;
    const flushOutput = () => {
        if (pendingBytes) parts.push(new Blob(pending as BlobPart[]));
        pending = []; pendingBytes = 0;
    };
    const startWriter = async () => {
        if (writer) return;
        const { ZipWriter, BlobReader, configure } = await import('@zip.js/zip.js');
        const { default: wasmURI } = await import('@zip.js/zip.js/dist/zip-module.wasm?url');
        configure({ wasmURI });
        const output = new WritableStream<Uint8Array>({ async write(chunk) {
            if (collector) { await collector.write(chunk); return; }
            for (let offset = 0; offset < chunk.byteLength;) {
                const length = Math.min(OUTPUT_PART_BYTES - pendingBytes, chunk.byteLength - offset);
                pending.push(chunk.slice(offset, offset + length)); pendingBytes += length; offset += length;
                if (pendingBytes === OUTPUT_PART_BYTES) flushOutput();
            }
        }});
        writer = { zip: new ZipWriter(output, { useWebWorkers: false, bufferedWrite: false, level: 6 }), BlobReader };
    };
    const writtenNames = new Set<string>();

    const fileBlob = (name: string, blob: Blob, options?: FileOptions) => {
        if (started) throw new Error('备份已开始压缩，不能继续添加文件');
        if (writtenNames.has(name)) throw new Error(`备份文件重复：${name}`);
        writtenNames.add(name);
        entries.set(name, { blob, options });
    };
    const file: ZipFileWriter['file'] = (name, data, options) => {
        if (options?.base64 && typeof data === 'string') {
            // Decode in aligned 64 KiB pieces instead of materializing a complete
            // image as a binary string and a second Uint8Array at the same time.
            const pieces: Blob[] = [];
            for (let offset = 0; offset < data.length; offset += 65536) {
                const decoded = atob(data.slice(offset, offset + 65536));
                const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
                pieces.push(new Blob([bytes]));
            }
            fileBlob(name, new Blob(pieces), options);
        } else {
            fileBlob(name, new Blob([data as BlobPart]), options);
        }
    };

    const drain = async () => {
        writing = writing.then(async () => {
            await startWriter();
            for (const [name, entry] of entries) {
                entries.delete(name);
                await writer.zip.add(name, new writer.BlobReader(entry.blob), { level: entry.options?.compression === 'STORE' ? 0 : 6 });
            }
        });
        await writing;
    };
    return {
        file,
        fileBlob,
        flush: drain,
        async dispose() {
            started = true;
            entries.clear(); parts.length = 0; pending = []; pendingBytes = 0;
            // A failed sink may already have errored. Release its writer without
            // masking the original export failure.
            await writing.catch(() => {});
            await writer?.zip.close().catch(() => {});
        },
        folder: (prefix: string) => ({
            file: (name: string, data: string | Uint8Array, options?: FileOptions) => file(`${prefix}/${name}`, data, options),
        }),
        async generateBlob(onProgress?: (metadata: { percent: number }) => void): Promise<Blob> {
            if (started) throw new Error('这份备份已生成，不能重复压缩');
            started = true;
            try {
                await drain();
                await writer.zip.close();
                flushOutput();
                onProgress?.({ percent: 100 });
                return collector ? await collector.finish() : new Blob(parts, { type: 'application/zip' });
            } finally {
                entries.clear();
                parts.length = 0;
                pending = [];
            }
        },
    };
}
