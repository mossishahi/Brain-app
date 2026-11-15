import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DocumentReader, extractDocumentHtml } from "../src/web/documents.js";
import { WebAccessManager } from "../src/web/manager.js";
import { buildWebAccessManager } from "../src/web/config.js";
import { webAnswerResult, webToolNames } from "../src/web/tools.js";

function pdfFixture(): Buffer {
  const stream = "BT /F1 18 Tf 40 700 Td (Methods: anisotropy and spectral directions) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /D /St 9 >>] >> >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(offset => `${offset.toString().padStart(10, "0")} 00000 n \n`).join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "reader-test-"));
  const server = createServer((req, res) => {
    if (req.url === "/pdf") { res.setHeader("content-type", "application/pdf"); res.end(pdfFixture()); return; }
    if (req.url === "/large") { res.setHeader("content-type", "text/html"); res.end(`<html><head><title>Long paper</title></head><body><article><h1>Introduction</h1><p>${"Long introduction. ".repeat(4000)}</p><h2>Methods</h2><p>Late method: anisotropy correction.</p><p>Repeated query ${"x".repeat(1000)} repeated query.</p></article></body></html>`); return; }
    if (req.url === "/landing") { res.setHeader("content-type", "text/html"); res.end('<html><head><meta name="citation_pdf_url" content="/pdf"></head><body><p>Abstract only</p></body></html>'); return; }
    if (req.url === "/redirect-private") { res.statusCode = 302; res.setHeader("location", "http://127.0.0.1/secret"); res.end(); return; }
    res.statusCode = 403; res.end("Forbidden");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const address = server.address() as { port: number };
  return { dir, url: `http://127.0.0.1:${address.port}`, reader: new DocumentReader({ rootDir: dir, fetchOptions: { allowPrivateAddresses: true } }) };
}
const owner = { taskId: "task-a", agentId: "agent-a" };

test("long HTML stays readable beyond former truncation, with stable scoped receipts and exact ranges", async t => {
  const { reader, url, dir } = await fixture(t);
  const opened = await reader.execute({ operation: "open", source: `${url}/large` }, owner);
  assert.equal((await reader.receipts(owner)).length, 0, "download is not inspection");
  const methods = opened.document.outline.find(s => s.heading === "Methods")!;
  const read = await reader.execute({ operation: "read", documentId: opened.document.documentId, sectionId: methods.sectionId }, owner);
  assert.match(read.passages!.map(p => p.text).join("\n"), /Late method/);
  assert.equal(read.receipt!.representationHash, opened.document.representationHash);
  assert.equal((await reader.receipts({ taskId: "task-b", agentId: "agent-a" })).length, 0);
  const restarted = new DocumentReader({ rootDir: dir });
  assert.deepEqual(await restarted.receipts(owner), await reader.receipts(owner));
  let cursor: string | undefined;
  let result = "";
  do {
    const chunk = await reader.execute({ operation: "read", documentId: opened.document.documentId, maxChars: 4000, ...(cursor ? { cursor } : {}) }, owner);
    result += chunk.passages!.map(p => p.text).join("");
    cursor = chunk.nextCursor;
  } while (cursor);
  assert.match(result, /Late method/);
  assert.ok(result.length > 48000);
  assert.equal((await reader.coverage(opened.document.documentId, owner)).fullyDelivered, true);
  assert.equal((await reader.coverage(opened.document.documentId, { taskId: "other", agentId: "other" })).fullyDelivered, false);
  const invalid = await reader.execute({ operation: "read", documentId: opened.document.documentId, maxChars: 10 }, owner);
  await assert.rejects(reader.execute({ operation: "read", documentId: opened.document.documentId, sectionId: methods.sectionId, cursor: invalid.nextCursor }, owner), /Invalid cursor/);
  const raw = await readFile(join(dir, "snapshots", opened.document.documentId, "source.bin"), "utf8");
  assert.match(raw, /<h2>Methods/);
});

test("search continuation returns later occurrences, with exact clipped locators", async t => {
  const { reader, url } = await fixture(t);
  const opened = await reader.execute({ operation: "open", source: `${url}/large` }, owner);
  const first = await reader.execute({ operation: "search", documentId: opened.document.documentId, query: "repeated query", maxResults: 1 }, owner);
  assert.equal(first.passages!.length, 1);
  assert.ok(first.nextCursor);
  const second = await reader.execute({ operation: "search", documentId: opened.document.documentId, query: "repeated query", maxResults: 1, cursor: first.nextCursor }, owner);
  assert.equal(second.passages!.length, 1);
  assert.ok(second.passages![0]!.locator.start > first.passages![0]!.locator.start);
  assert.equal(second.passages![0]!.text.length, second.passages![0]!.locator.end - second.passages![0]!.locator.start);
});

test("PDF pages, printed labels, scanned/blank status, actual visual image, and source hash", async t => {
  const { reader, url } = await fixture(t);
  const opened = await reader.execute({ operation: "open", source: `${url}/pdf` }, owner);
  assert.equal(opened.document.pageCount, 2);
  assert.equal(opened.document.extraction, "partial");
  const read = await reader.execute({ operation: "read", documentId: opened.document.documentId, page: 1 }, owner);
  assert.match(read.passages![0]!.text, /anisotropy/);
  assert.equal(read.passages![0]!.locator.page, 1);
  assert.equal(read.passages![0]!.locator.pageLabel, "9");
  assert.equal((await reader.coverage(opened.document.documentId, owner)).fullyDelivered, false);
  const image = await reader.execute({ operation: "page_image", documentId: opened.document.documentId, page: 2 }, owner);
  assert.equal((await reader.coverage(opened.document.documentId, owner)).fullyDelivered, true);
  assert.equal(Buffer.from(image.image!.data, "base64").subarray(1, 4).toString(), "PNG");
  const result = webAnswerResult(image);
  assert.equal(result.blocks![1]!.type, "image");
  assert.ok(!JSON.stringify(result.output).includes(image.image!.data));
  assert.equal(image.receipt!.operation, "page_image");
  const reopened = await reader.execute({ operation: "open", source: `${url}/pdf` }, owner);
  assert.deepEqual(reopened.document, opened.document);
});

test("publisher metadata resolves PDF and failures never invent receipts", async t => {
  const { reader, url } = await fixture(t);
  const opened = await reader.execute({ operation: "open", source: `${url}/landing` }, owner);
  assert.equal(opened.document.contentType, "application/pdf");
  await assert.rejects(reader.execute({ operation: "open", source: `${url}/forbidden` }, owner), /HTTP 403/);
  assert.equal((await reader.receipts(owner)).length, 0);
  await assert.rejects(reader.execute({ operation: "read", documentId: "../../secret" }, owner), /Invalid document_id/);
});

test("reader uses public address policy and rejects oversized source instead of persisting truncated evidence", async t => {
  const { dir, url } = await fixture(t);
  const guarded = new DocumentReader({ rootDir: dir });
  await assert.rejects(guarded.execute({ operation: "open", source: url }, owner), /default http|public address/);
  const limited = new DocumentReader({ rootDir: dir, fetchOptions: { allowPrivateAddresses: true, maxBytes: 100 } });
  await assert.rejects(limited.execute({ operation: "open", source: `${url}/large` }, owner), /byte limit/);
  assert.equal((await limited.receipts(owner)).length, 0);
});

test("paper_read is available in native search mode; manager logs receipts and no image base64", async t => {
  const { dir, url } = await fixture(t);
  const native = buildWebAccessManager({ config: { mode: "agent" }, documents: { rootDir: dir } });
  assert.deepEqual(webToolNames(native!), ["paper_read"]);
  const rows: unknown[] = [];
  const manager = new WebAccessManager({ providers: [], chains: {}, documents: { rootDir: dir }, fetchOptions: { allowPrivateAddresses: true }, log: row => rows.push(row) });
  const opened = await manager.document!({ operation: "open", source: `${url}/pdf` }, owner);
  const image = await manager.document!({ operation: "page_image", documentId: opened.document.documentId, page: 1 }, owner);
  assert.ok(!JSON.stringify(rows).includes(image.image!.data));
  assert.match(JSON.stringify(rows), /paper_read/);
  assert.equal((await manager.documentReceipts!(owner)).length, 1);
});

test("HTML preserves scientific section boundaries without duplicate nested paragraphs", () => {
  const html = '<html><body><article><h1>Paper</h1><p>A</p><h2>Methods</h2><blockquote><p>Quoted method</p></blockquote><table><tr><td>x</td><td>1</td></tr></table></article></body></html>';
  const parsed = extractDocumentHtml(html);
  assert.equal(parsed.outline[1]!.heading, "Methods");
  assert.equal(parsed.segments.filter(s => s.text === "Quoted method").length, 1);
});

test("HTML retains bare text and div content alongside paragraphs", () => {
  const parsed = extractDocumentHtml('<html><body><div>Bare result<p>Paragraph result</p>Trailing result<div>Div result</div></div><article><p>Another article</p></article></body></html>');
  const all = parsed.segments.map(x => x.text).join(" ");
  for (const text of ["Bare result", "Paragraph result", "Trailing result", "Div result", "Another article"]) assert.ok(all.includes(text));
});

test("narrow search budget advances rather than returning an endless pre-match window", async t => {
  const { reader, url } = await fixture(t);
  const opened = await reader.execute({ operation: "open", source: `${url}/large` }, owner);
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const read = await reader.execute({ operation: "search", documentId: opened.document.documentId, query: "repeated query", maxChars: 5, ...(cursor ? { cursor } : {}) }, owner);
    cursor = read.nextCursor;
    if (!cursor) return;
    assert.ok(!seen.has(cursor)); seen.add(cursor);
  }
  assert.fail("Search should exhaust both occurrences");
});

test("parser failures and parsing deadlines do not publish partial snapshots or receipts", async t => {
  const { dir, url } = await fixture(t);
  const limited = new DocumentReader({ rootDir: dir, maxPages: 1, fetchOptions: { allowPrivateAddresses: true } });
  await assert.rejects(limited.execute({ operation: "open", source: `${url}/pdf` }, owner), /page document safety bound/);
  const timed = new DocumentReader({ rootDir: dir, parseTimeoutMs: 1, fetchOptions: { allowPrivateAddresses: true } });
  await assert.rejects(timed.execute({ operation: "open", source: `${url}/large` }, owner), /parsing exceeded/);
  assert.deepEqual(await timed.receipts(owner), []);
});
