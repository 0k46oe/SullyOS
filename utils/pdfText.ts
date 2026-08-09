const PDFJS_SCRIPT_SRC = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER_SRC = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

type PdfTextItemLike = {
    str?: unknown;
    hasEOL?: boolean;
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

export const pdfItemsToText = (items: PdfTextItemLike[]): string => {
    let text = '';
    for (const item of items) {
        const value = typeof item.str === 'string' ? item.str.replace(/\u0000/g, '') : '';
        if (value) text += value;
        text += item.hasEOL ? '\n' : ' ';
    }
    return text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
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
