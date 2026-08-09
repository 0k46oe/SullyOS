import { describe, expect, it, vi } from 'vitest';
import {
    extractPdfDocumentText,
    isPdfFile,
    pdfItemsToText,
    type PdfDocumentLike,
} from './pdfText';

describe('PDF 文本提取', () => {
    it('同时识别 MIME 和扩展名', () => {
        expect(isPdfFile({ name: 'novel.bin', type: 'application/pdf' })).toBe(true);
        expect(isPdfFile({ name: 'novel.PDF', type: '' })).toBe(true);
        expect(isPdfFile({ name: 'novel.txt', type: 'text/plain' })).toBe(false);
    });

    it('保留 PDF.js 标记的换行并清理多余空白', () => {
        expect(pdfItemsToText([
            { str: '第一段', hasEOL: true },
            { str: '第二段' },
            { str: '继续', hasEOL: true },
        ])).toBe('第一段\n第二段 继续');
    });

    it('逐页提取全文、报告进度并释放页面资源', async () => {
        const cleanup = vi.fn();
        const progress = vi.fn();
        const pdf: PdfDocumentLike = {
            numPages: 2,
            getPage: vi.fn(async pageNumber => ({
                getTextContent: async () => ({ items: [{ str: `第 ${pageNumber} 页`, hasEOL: true }] }),
                cleanup,
            })),
        };

        const result = await extractPdfDocumentText(pdf, { onProgress: progress });

        expect(result).toEqual({ text: '第 1 页\n\n第 2 页', pageCount: 2, extractedPages: 2 });
        expect(progress).toHaveBeenNthCalledWith(1, { page: 1, totalPages: 2 });
        expect(progress).toHaveBeenNthCalledWith(2, { page: 2, totalPages: 2 });
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it('为学习 App 保留可配置的页数上限', async () => {
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: async () => ({ items: [{ str: `P${pageNumber}` }] }),
        }));
        const result = await extractPdfDocumentText({ numPages: 80, getPage }, { maxPages: 50 });

        expect(result.extractedPages).toBe(50);
        expect(result.pageCount).toBe(80);
        expect(getPage).toHaveBeenCalledTimes(50);
        expect(getPage).toHaveBeenLastCalledWith(50);
    });
});
