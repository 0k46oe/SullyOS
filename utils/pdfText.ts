const PDFJS_SCRIPT_SRC = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER_SRC = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

type PdfTextItemLike = {
    str?: unknown;
    hasEOL?: boolean;
    transform?: number[];
    height?: number;
};

type PdfTextLine = {
    text: string;
    x?: number;
    y?: number;
    height?: number;
    blank?: boolean;
};

type PdfPageLike = {
    getTextContent: () => Promise<{ items?: PdfTextItemLike[] }>;
    cleanup?: () => void;
};

export type PdfDocumentLike = {
    numPages: number;
    getPage: (pageNumber: number) => Promise<PdfPageLike>;
    destroy?: () => Promise<void> | void;
};

type PdfJsLike = {
    getDocument: (src: { data: ArrayBuffer }) => { promise: Promise<PdfDocumentLike> };
    GlobalWorkerOptions?: { workerSrc?: string };
};

export interface PdfExtractionProgress {
    page: number;
    totalPages: number;
}

export interface PdfTextResult {
    text: string;
    pageCount: number;
    extractedPages: number;
}

export interface ExtractPdfTextOptions {
    maxPages?: number;
    onProgress?: (progress: PdfExtractionProgress) => void;
}

let pdfjsPromise: Promise<PdfJsLike> | null = null;

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
        if (existing.dataset.loaded === 'true' || (window as any).pdfjsLib) {
            resolve();
            return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`load failed: ${src}`)), { once: true });
        return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.src = src;
    script.onload = () => {
        script.dataset.loaded = 'true';
        resolve();
    };
    script.onerror = () => reject(new Error(`load failed: ${src}`));
    document.head.appendChild(script);
});

const loadPdfJs = async (): Promise<PdfJsLike> => {
    if (!pdfjsPromise) {
        pdfjsPromise = loadScript(PDFJS_SCRIPT_SRC)
            .then(() => {
                const pdfjs = (window as any).pdfjsLib as PdfJsLike | undefined;
                if (!pdfjs) throw new Error('PDF.js 加载失败');
                if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
                return pdfjs;
            })
            .catch(error => {
                pdfjsPromise = null;
                throw error;
            });
    }
    return pdfjsPromise;
};

export const isPdfFile = (file: Pick<File, 'name' | 'type'>): boolean =>
    file.type.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name);

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const NO_SPACE_BEFORE = /^[,.;:!?%。，、；：！？）》】』”’]/;
const NO_SPACE_AFTER = /[(（《【『“‘]$/;
const CHAPTER_HEADING = /^(?:第.{1,12}[章节回部卷篇]|chapter\b)/i;

const finiteNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const itemMetrics = (item: PdfTextItemLike) => {
    const x = finiteNumber(item.transform?.[4]);
    const y = finiteNumber(item.transform?.[5]);
    const height = (finiteNumber(item.height) ?? Math.abs(finiteNumber(item.transform?.[3]) ?? 0)) || undefined;
    return { x, y, height };
};

const inlineSeparator = (left: string, right: string): string => {
    if (!left || !right || /\s$/.test(left) || /^\s/.test(right)) return '';
    if (NO_SPACE_BEFORE.test(right) || NO_SPACE_AFTER.test(left)) return '';
    if (CJK_CHAR.test(left.slice(-1)) && CJK_CHAR.test(right[0])) return '';
    return ' ';
};

const isNewVisualLine = (line: PdfTextLine, item: PdfTextItemLike): boolean => {
    const next = itemMetrics(item);
    if (line.y == null || next.y == null) return false;
    const height = Math.max(line.height || 0, next.height || 0, 1);
    return Math.abs(line.y - next.y) > height * 0.55;
};

const shouldKeepParagraphBreak = (previous: PdfTextLine, current: PdfTextLine, leftEdge?: number): boolean => {
    if (previous.blank || current.blank) return true;
    if (CHAPTER_HEADING.test(previous.text.trim()) || CHAPTER_HEADING.test(current.text.trim())) return true;

    const lineHeight = Math.max(previous.height || 0, current.height || 0, 1);
    if (previous.y != null && current.y != null && Math.abs(previous.y - current.y) > lineHeight * 1.65) {
        return true;
    }
    if (leftEdge != null && current.x != null && current.x - leftEdge > lineHeight * 1.4) {
        return true;
    }
    return false;
};

const joinPdfLines = (lines: PdfTextLine[]): string => {
    const contentLines = lines.filter(line => line.text || line.blank);
    const xValues = contentLines
        .map(line => line.x)
        .filter((value): value is number => value != null);
    const leftEdge = xValues.length
        ? xValues.reduce((minimum, value) => Math.min(minimum, value), xValues[0])
        : undefined;
    let output = '';
    let previous: PdfTextLine | undefined;
    let pendingBlank = false;

    for (const line of contentLines) {
        if (line.blank || !line.text) {
            pendingBlank = !!previous;
            continue;
        }
        if (!previous) {
            output = line.text;
            previous = line;
            continue;
        }

        if (pendingBlank || shouldKeepParagraphBreak(previous, line, leftEdge)) {
            output += `\n\n${line.text}`;
        } else if (/[-‐‑]$/.test(output) && /^[a-z]/i.test(line.text)) {
            output = `${output.slice(0, -1)}${line.text}`;
        } else {
            output += `${inlineSeparator(output, line.text)}${line.text}`;
        }
        previous = line;
        pendingBlank = false;
    }

    return output.trim();
};

export const pdfItemsToText = (items: PdfTextItemLike[]): string => {
    const lines: PdfTextLine[] = [];
    let line: PdfTextLine = { text: '' };

    const flush = (blank = false) => {
        if (line.text.trim() || blank) lines.push({ ...line, text: line.text.trim(), blank });
        line = { text: '' };
    };

    for (const item of items) {
        const value = typeof item.str === 'string' ? item.str.replace(/\u0000/g, '') : '';
        if (value && line.text && isNewVisualLine(line, item)) flush();
        if (value) {
            const metrics = itemMetrics(item);
            line.x ??= metrics.x;
            line.y ??= metrics.y;
            line.height = Math.max(line.height || 0, metrics.height || 0) || undefined;
            line.text += `${inlineSeparator(line.text, value)}${value}`;
        }
        if (item.hasEOL) flush(!value && !line.text);
    }
    flush();
    return joinPdfLines(lines);
};

export const extractPdfDocumentText = async (
    pdf: PdfDocumentLike,
    options: ExtractPdfTextOptions = {},
): Promise<PdfTextResult> => {
    const requestedPages = options.maxPages == null
        ? pdf.numPages
        : Math.max(0, Math.floor(options.maxPages));
    const extractedPages = Math.min(pdf.numPages, requestedPages);
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= extractedPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        try {
            const content = await page.getTextContent();
            pages.push(pdfItemsToText(content.items || []));
        } finally {
            page.cleanup?.();
        }
        options.onProgress?.({ page: pageNumber, totalPages: extractedPages });
    }

    return {
        text: pages.filter(Boolean).join('\n\n').trim(),
        pageCount: pdf.numPages,
        extractedPages,
    };
};

export const extractPdfText = async (
    data: ArrayBuffer,
    options: ExtractPdfTextOptions = {},
): Promise<PdfTextResult> => {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data }).promise;
    try {
        return await extractPdfDocumentText(pdf, options);
    } finally {
        await pdf.destroy?.();
    }
};
