import { DB } from './db';
import { createV2ArrayFieldWriter, type ZipFileWriter } from './backupFormat';
import { compactMemoryLink } from './memoryPalace/linkPrecision';

/** One bounded snapshot scan per store. Compression checkpoints drain completed
 * shards while the reader keeps its transaction active across asynchronous I/O. */
export async function streamBackupArrayStore(
    zip: ZipFileWriter,
    storeName: string,
    field: string,
    options: {
        transform?: (item: any, index: number) => any;
        onSerialized?: (json: string) => void;
        onProgress?: (count: number) => void;
    } = {},
): Promise<{ parts: number; count: number }> {
    const writer = createV2ArrayFieldWriter(zip, field, {
        limits: { maxLen: 1024 * 1024, maxItems: storeName === 'memory_links' ? 5000 : 500, hardMaxLen: 256 * 1024 * 1024 },
        onSerialized: options.onSerialized,
    });
    let index = 0;
    await DB.streamStoreBatches(storeName, async batch => {
        for (const item of batch) {
            const row = storeName === 'memory_links' ? compactMemoryLink(item) : item;
            writer.appendSync([options.transform ? options.transform(row, index) : row]);
            index++;
        }
        await zip.flush?.();
        options.onProgress?.(index);
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    const result = await writer.finish();
    await zip.flush?.();
    return result;
}
