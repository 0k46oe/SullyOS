import { BlobReader, ZipReader, Uint8ArrayWriter, TextWriter, configure } from '@zip.js/zip.js';
import wasmURI from '@zip.js/zip.js/dist/zip-module.wasm?url';
import type { ZipFileReader } from './backupFormat';
export async function openBackupZip(blob: Blob) {
    configure({ wasmURI });
    const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
    try {
        const entries = await reader.getEntries();
        const files: Record<string, any> = Object.create(null);
        for (const entry of entries) {
            if (entry.directory) continue;
            if (files[entry.filename]) throw new Error(`备份中有重复路径：${entry.filename}`);
            files[entry.filename] = {
                name: entry.filename,
                _data: { compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize },
                async async(type: string) {
                    if (type === 'string') return entry.getData!(new TextWriter(), { checkSignature: true });
                    const bytes = await entry.getData!(new Uint8ArrayWriter(), { checkSignature: true });
                    if (type !== 'base64') return bytes;
                    const parts: string[] = [];
                    for (let i = 0; i < bytes.length; i += 0x6000) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 0x6000))));
                    return parts.join('');
                },
            };
        }
        return { files, file: (name: string) => files[name] || null, close: () => reader.close() };
    } catch (error) { await reader.close(); throw error; }
}
export type BackupZipReader = Awaited<ReturnType<typeof openBackupZip>> & ZipFileReader;
