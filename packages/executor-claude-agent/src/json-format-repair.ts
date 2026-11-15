import type { JsonValue } from "@brainstorm-agentic/core";

type ScalarToken = readonly [kind: "string" | "number" | "literal", value: string];
interface Lexeme {
  readonly end: number;
  /** Absent for a complete scalar token. */
  readonly punctuation?: string;
}

interface LexedJson {
  readonly source: string;
  readonly scalars: readonly ScalarToken[];
  readonly lexemes: readonly Lexeme[];
}

const whitespace = /[ \t\r\n]/;
const punctuation = /[{}\[\],:]/;
// A quote is an unambiguous next token even when the comma before it is missing.
const boundary = /[{}\[\],:" \t\r\n]/;
const numberPrefix = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function unfence(text: string): string {
  const trimmed = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/** Exact decimal value, so serialization cannot hide integer rounding or underflow. */
function numericValue(token: string): string | undefined {
  if (!Number.isFinite(Number(token))) return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return undefined;
  const fraction = match[3] ?? "";
  const digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (digits === "") return "0";
  const significant = digits.replace(/0+$/, "");
  const exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return `${match[1]}${significant}e${exponent}`;
}

/** Lex scalars without trusting the damaged object's nesting or separators. */
function lexJson(text: string, checkBudget?: () => void): LexedJson | undefined {
  const source = unfence(text);
  if (source.length === 0) return undefined;
  const tokens: ScalarToken[] = [];
  const lexemes: Lexeme[] = [];
  let nextBudgetCheck = 1024;
  for (let index = 0; index < source.length;) {
    if (index >= nextBudgetCheck) {
      checkBudget?.();
      nextBudgetCheck = index + 1024;
    }
    const character = source[index]!;
    if (whitespace.test(character)) {
      index += 1;
      continue;
    }
    if (punctuation.test(character)) {
      lexemes.push({ end: ++index, punctuation: character });
      continue;
    }
    if (character === '"') {
      const start = index++;
      let closed = false;
      while (index < source.length) {
        if (index >= nextBudgetCheck) {
          checkBudget?.();
          nextBudgetCheck = index + 1024;
        }
        if (source[index] === "\\") {
          index += 2;
        } else if (source[index++] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) return undefined;
      try {
        // JSON.parse rejects malformed escapes and unescaped control characters.
        const value: unknown = JSON.parse(source.slice(start, index));
        if (typeof value !== "string") return undefined;
        tokens.push(["string", value]);
        lexemes.push({ end: index });
      } catch {
        return undefined;
      }
      continue;
    }
    if (character === "-" || /[0-9]/.test(character)) {
      const token = numberPrefix.exec(source.slice(index))?.[0];
      if (!token) return undefined;
      index += token.length;
      // Reject 01, 1e, 1., 1+2, etc. rather than splitting invalid scalar tokens.
      if (index < source.length && !boundary.test(source[index]!)) return undefined;
      const value = numericValue(token);
      if (value === undefined) return undefined;
      tokens.push(["number", value]);
      lexemes.push({ end: index });
      continue;
    }
    const literal = /^(?:true|false|null)/.exec(source.slice(index))?.[0];
    if (!literal) return undefined;
    index += literal.length;
    if (index < source.length && !boundary.test(source[index]!)) return undefined;
    tokens.push(["literal", literal]);
    lexemes.push({ end: index });
  }
  return { source, scalars: tokens, lexemes };
}

function serializeJson(repaired: JsonValue): string | undefined {
  return JSON.stringify(repaired, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("nonfinite JSON number");
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new Error("not a JSON value");
    }
    return value;
  });
}

function sameScalars(before: readonly ScalarToken[], serialized: string, checkBudget?: () => void): boolean {
  const after = lexJson(serialized, checkBudget)?.scalars;
  return after !== undefined && before.length === after.length && before.every((token, index) => {
    const candidate = after[index]!;
    return token[0] === candidate[0] && token[1] === candidate[1];
  });
}

/**
 * Accept only a repair of JSON delimiters/whitespace. Every decoded key and
 * scalar value must remain in the original order. The caller must separately
 * validate the repaired object against its task schema: preserving tokens does
 * not establish that the newly chosen nesting is the intended output shape.
 */
export function formattingTokensUnchanged(original: string, repaired: JsonValue): boolean {
  try {
    const before = lexJson(original)?.scalars;
    if (before === undefined) return false;
    const serialized = serializeJson(repaired);
    if (serialized === undefined) return false;
    return sameScalars(before, serialized);
  } catch {
    return false;
  }
}

export interface ClosingDelimiterRepair {
  readonly value: JsonValue;
  readonly text: string;
  /** Insertion position in the trimmed, unfenced original JSON. */
  readonly offset: number;
  readonly delimiter: "}" | "]";
}

export class JsonRepairSearchLimitError extends Error {
  constructor() {
    super("JSON closing-delimiter repair search exceeded its time budget");
    this.name = "JsonRepairSearchLimitError";
  }
}

/**
 * Enumerate complete parses obtained by inserting exactly one missing closing
 * delimiter. Exhaust this iterator before accepting a unique schema-valid
 * candidate. A search-limit error invalidates ALL candidates yielded so far.
 * No scalar content, missing value, comma, opening delimiter, or escape is fixed.
 */
export function* singleClosingDelimiterRepairs(
  raw: string,
  options: { readonly maxDurationMs?: number; readonly now?: () => number } = {},
): IterableIterator<ClosingDelimiterRepair> {
  const now = options.now ?? (() => performance.now());
  const maxDurationMs = options.maxDurationMs ?? 250;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new RangeError("maxDurationMs must be positive and finite");
  const deadline = now() + maxDurationMs;
  const checkBudget = (): void => {
    if (now() >= deadline) throw new JsonRepairSearchLimitError();
  };
  const lexed = lexJson(raw, checkBudget);
  checkBudget();
  if (!lexed) return;
  // A number or literal ending exactly with the draft could itself have been
  // cut (12345 -> 123). A closing quote or structural delimiter establishes a
  // definite scalar boundary; never guess a missing boundary at numeric EOF.
  if (lexed.lexemes.at(-1)?.punctuation === undefined && lexed.scalars.at(-1)?.[0] !== "string") return;
  let braces = 0;
  let brackets = 0;
  for (const token of lexed.lexemes) {
    if (token.punctuation === "{") braces += 1;
    if (token.punctuation === "}") braces -= 1;
    if (token.punctuation === "[") brackets += 1;
    if (token.punctuation === "]") brackets -= 1;
  }
  const delimiter = braces === 1 && brackets === 0 ? "}" : braces === 0 && brackets === 1 ? "]" : undefined;
  if (!delimiter) return;
  const opening = delimiter === "}" ? "{" : "[";
  const stack: string[] = [];
  const seen = new Set<string>();
  for (const token of lexed.lexemes) {
    checkBudget();
    const symbol = token.punctuation;
    if (symbol === "{" || symbol === "[") stack.push(symbol);
    else if (symbol === "}" || symbol === "]") {
      // Any insertion that repairs this mismatch must precede it. No later
      // boundary can alter an already mismatched prefix.
      if (stack.at(-1) !== (symbol === "}" ? "{" : "[")) return;
      stack.pop();
    }
    if (symbol === ":" || symbol === "," || stack.at(-1) !== opening) continue;
    const text = lexed.source.slice(0, token.end) + delimiter + lexed.source.slice(token.end);
    let value: JsonValue;
    try {
      value = JSON.parse(text) as JsonValue;
    } catch {
      continue;
    }
    checkBudget();
    // Detect duplicate keys and precision loss that JSON.parse would otherwise
    // silently normalize, even though the candidate changed only punctuation.
    const serialized = serializeJson(value);
    if (serialized === undefined || !sameScalars(lexed.scalars, serialized, checkBudget)) continue;
    checkBudget();
    if (seen.has(serialized)) continue;
    seen.add(serialized);
    yield { value, text, offset: token.end, delimiter };
  }
  checkBudget();
}
