export type ReferenceSegment = { text: string; href?: string };

function trimProsePunctuation(raw: string): string {
  let end = raw.length;
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  while (end > 0) {
    const last = raw[end - 1]!;
    if (/[.,;:!?]/.test(last)) { end--; continue; }
    const opener = pairs[last];
    if (opener) {
      const value = raw.slice(0, end);
      if (value.split(last).length > value.split(opener).length) { end--; continue; }
    }
    break;
  }
  return raw.slice(0, end);
}

/** Preserve prose and only link HTTP(S) references; never interpret HTML. */
export function referenceLinks(text: string): ReferenceSegment[] {
  const segments: ReferenceSegment[] = [];
  const starts = /\[([^\]\n]+)\]\((https?:\/\/)|https?:\/\//gi;
  let cursor = 0;
  for (let match = starts.exec(text); match; match = starts.exec(text)) {
    const label = match[1];
    const urlStart = label === undefined ? match.index : starts.lastIndex - match[2]!.length;
    let end = urlStart;
    let depth = 0;
    while (end < text.length && !/[\s<>"'`]/.test(text[end]!)) {
      const char = text[end]!;
      if (label !== undefined && char === ")" && depth === 0) break;
      if (char === "(") depth++;
      if (char === ")") depth--;
      end++;
    }
    const markdown = label !== undefined && text[end] === ")";
    const raw = text.slice(urlStart, end);
    const href = markdown ? raw : trimProsePunctuation(raw);
    try {
      const url = new URL(href);
      if (!url.hostname || !["http:", "https:"].includes(url.protocol)) continue;
    } catch { continue; }
    const start = markdown ? match.index : urlStart;
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    segments.push({ text: markdown ? label! : href, href });
    cursor = markdown ? end + 1 : urlStart + href.length;
    starts.lastIndex = cursor;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
