/** No source URL is fetched in this worker. Only host-downloaded bytes enter it. */
import { parentPort, workerData } from "node:worker_threads";
import type { DocumentDescriptor, DocumentLocator } from "@brainstorm-agentic/core";
import { extractDocumentHtml } from "./documents.js";
import type { ParserRequest } from "./document-parser.js";

const MAX_EXTRACTED_CHARS = 12_000_000;
async function parse(request: ParserRequest): Promise<unknown> {
  if (request.operation === "html") {
    const parsed = extractDocumentHtml(request.html);
    if (parsed.segments.reduce((sum, item) => sum + item.text.length, 0) > MAX_EXTRACTED_CHARS) throw new Error("Extracted HTML exceeds the 12 million character document safety bound.");
    return parsed;
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: Uint8Array.from(request.bytes), useSystemFonts: true, maxImageSize: 16_000_000 });
  try {
    const pdf = await task.promise;
    if (request.operation === "image") {
      const { createCanvas } = await import("@napi-rs/canvas");
      const page = await pdf.getPage(request.page);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1600 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > 2_560_000) throw new Error("PDF page has unsupported rendering dimensions.");
      const canvas = createCanvas(width, height);
      await page.render({ canvas: canvas as never, canvasContext: canvas.getContext("2d") as never, viewport }).promise;
      return new Uint8Array(canvas.toBuffer("image/png"));
    }
    if (pdf.numPages > request.maxPages) throw new Error(`PDF has ${pdf.numPages} pages, exceeding the ${request.maxPages}-page document safety bound.`);
    const labels = await pdf.getPageLabels();
    const metadata = await pdf.getMetadata().catch(() => undefined);
    const title = metadata && "Title" in metadata.info && typeof metadata.info.Title === "string" ? metadata.info.Title : undefined;
    const segments: { locator: DocumentLocator; text: string }[] = [];
    let totalChars = 0;
    for (let page = 1; page <= pdf.numPages; page += 1) {
      const docPage = await pdf.getPage(page);
      const content = await docPage.getTextContent();
      const text = content.items.map(item => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").replace(/[ \t]+\n/g, "\n").trim();
      totalChars += text.length;
      if (totalChars > MAX_EXTRACTED_CHARS) throw new Error("Extracted PDF exceeds the 12 million character document safety bound.");
      segments.push({ locator: { segmentId: `page-${page}`, page, ...(labels?.[page - 1] ? { pageLabel: labels[page - 1]!.slice(0, 128) } : {}), start: 0, end: text.length }, text });
      docPage.cleanup();
    }
    const outline: DocumentDescriptor["outline"] = segments.map(s => ({ sectionId: s.locator.segmentId, heading: `Physical page ${s.locator.page}${s.locator.pageLabel ? ` (label ${s.locator.pageLabel})` : ""}`, page: s.locator.page }));
    const empty = segments.filter(s => !s.text.trim()).length;
    return { segments, outline, pageCount: pdf.numPages, ...(title ? { title } : {}), warnings: [
      "PDF text extraction does not certify reading order, equations, tables, or figures. Use page_image to inspect those visually. Images above 16 million pixels are not rendered; inspect the original source if large artwork is missing.",
      ...(empty ? [`${empty} page(s) have no extractable text; they may be scanned or blank. OCR was not performed.`] : []),
    ] };
  } finally { await task.destroy(); }
}

void parse(workerData as ParserRequest).then(
  value => parentPort!.postMessage({ ok: true, value }),
  error => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
);
