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

    it('合并中文 PDF 的视觉折行，不在半句话中留下换行或空格', () => {
        expect(pdfItemsToText([
            { str: '她抬头看向窗外，夜色正' },
            { str: '', hasEOL: true },
            { str: '一点点漫进房间。', hasEOL: true },
        ])).toBe('她抬头看向窗外，夜色正一点点漫进房间。');
    });

    it('合并英文软换行并去掉行末断词连字符', () => {
        expect(pdfItemsToText([
            { str: 'The sentence was inter-', hasEOL: true },
            { str: 'rupted by a visual line break.', hasEOL: true },
        ])).toBe('The sentence was interrupted by a visual line break.');
    });

    it('保留显式空行和明显的版面段间距', () => {
        expect(pdfItemsToText([
            { str: '第一段。' },
            { str: '', hasEOL: true },
            { str: '', hasEOL: true },
            { str: '第二段。', hasEOL: true },
        ])).toBe('第一段。\n\n第二段。');

        expect(pdfItemsToText([
            { str: '同一段的第一行', hasEOL: true, transform: [12, 0, 0, 12, 40, 700], height: 12 },
            { str: '继续这一段。', hasEOL: true, transform: [12, 0, 0, 12, 40, 686], height: 12 },
            { str: '新的自然段。', hasEOL: true, transform: [12, 0, 0, 12, 40, 650], height: 12 },
        ])).toBe('同一段的第一行继续这一段。\n\n新的自然段。');
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
