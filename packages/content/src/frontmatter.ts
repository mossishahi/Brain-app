/**
 * Minimal front matter parser for skill files. Supports the strict subset the
 * content package uses: `---`-delimited front matter of single-line
 * `key: value` entries, where a value is a plain scalar, a double-quoted
 * string, or an inline list `[a, b, c]`.
 */

export interface ParsedFrontMatter {
  data: Record<string, string | string[]>;
  body: string;
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

function parseValue(raw: string): string | string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) {
      throw new Error(`unterminated inline list: ${trimmed}`);
    }
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  return parseScalar(trimmed);
}

export function parseFrontMatter(text: string): ParsedFrontMatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error("file must start with a `---` front matter delimiter");
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) {
    throw new Error("front matter is missing its closing `---` delimiter");
  }

  const data: Record<string, string | string[]> = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!match) {
      throw new Error(`front matter line is not a \`key: value\` entry: ${JSON.stringify(line)}`);
    }
    const key = match[1]!;
    if (key in data) {
      throw new Error(`duplicate front matter key: ${key}`);
    }
    data[key] = parseValue(match[2]!);
  }

  return { data, body: lines.slice(end + 1).join("\n") };
}
