/**
 * Web host tools.
 *
 * `web_fetch` is fully implemented here: it retrieves one public http(s)
 * URL through the process's outbound dispatcher (proxy-aware when the host
 * configured one) and hands the model readable text. The MODEL chooses the
 * URL, so the fetcher treats every request as hostile until proven public:
 *
 * - http(s) only, no embedded credentials, default ports only;
 * - the hostname must resolve to PUBLIC addresses — loopback, RFC1918,
 *   link-local (cloud metadata), CGNAT, ULA, multicast, and documentation
 *   ranges are refused, for literal IPs and for every DNS answer;
 * - redirects are followed manually and every hop is re-validated;
 * - on direct (proxy-less) connections a dedicated undici Agent re-checks
 *   the resolved address AT CONNECT TIME, closing the DNS-rebinding window
 *   between pre-flight and connection (with a proxy, the proxy performs the
 *   egress and enforces its own policy; the pre-flight still applies);
 * - download size, total time, and returned characters are all bounded.
 *
 * The search tools (web_search, news_search, paper_search, paper_details)
 * are implemented by the unified web layer (see ./web/): the
 * WebAccessManager routes each query type to its ordered source list
 * (SearXNG, scholarly indexes, the paid fallback) and logs every call. This
 * module keeps the manifests, the tool definitions, and the ONE hardened
 * fetch implementation (`performWebFetch`) the manager wraps.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type {
  HostToolManifest,
  JsonValue,
  Tool,
  ToolResult,
  WebFetchAnswer,
} from "@brainstorm-agentic/core";
import { Agent, fetch as httpFetch } from "undici";

// ---------------------------------------------------------------------------
// Search backend interface
// ---------------------------------------------------------------------------

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published?: string;
  readonly source?: string;
}

export interface SearchBackend {
  search(query: string, options: { maxResults: number; signal?: AbortSignal }): Promise<readonly SearchHit[]>;
}

// ---------------------------------------------------------------------------
// Public-address guard (shared by pre-flight checks and the connect guard)
// ---------------------------------------------------------------------------

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** First 16-bit group of an IPv6 address, tolerating `::` compression. */
function ipv6Group(ip: string, index: number): number {
  const bare = ip.split("%")[0]!.toLowerCase();
  const [head = ""] = bare.split("::", 1);
  const groups = head === "" ? [] : head.split(":");
  const value = Number.parseInt(groups[index] ?? "0", 16);
  return Number.isFinite(value) ? value : 0;
}

function isPublicIpv6(ip: string): boolean {
  const bare = ip.split("%")[0]!.toLowerCase();
  // Compressed-zero forms cover ::, ::1, and every v4-mapped/translated
  // shape. No legitimate public site publishes those in AAAA records, so
  // they are refused wholesale rather than parsed further.
  if (bare.startsWith("::")) return false;
  const first = ipv6Group(bare, 0);
  if (first === 0) return false; // 0::/16 (unspecified, loopback, mapped)
  if (first >= 0xfc00 && first <= 0xfdff) return false; // ULA fc00::/7
  if (first >= 0xfe80 && first <= 0xfebf) return false; // link-local fe80::/10
  if (first >= 0xff00) return false; // multicast ff00::/8
  if (first === 0x2001 && ipv6Group(bare, 1) === 0xdb8) return false; // docs
  if (first === 0x64 && ipv6Group(bare, 1) === 0xff9b) return false; // NAT64
  return true;
}

/** Whether a literal IP is publicly routable (non-IPs are not addresses). */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family === 6) return isPublicIpv6(ip);
  return false;
}

/** Hostname suffixes that always name internal services. */
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

function isInternalHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/\.$/, "");
  return bare === "localhost" || INTERNAL_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// Outbound dispatcher
// ---------------------------------------------------------------------------

/**
 * Connect-time address guard for direct connections: net.connect consults
 * this instead of plain DNS, so the address the socket actually dials is the
 * address that passed the public check — a DNS answer that changes between
 * pre-flight and connect (rebinding) is caught here.
 */
function guardedLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address?: string | { address: string; family: number }[],
    family?: number,
  ) => void,
): void {
  lookup(hostname, { all: true, verbatim: true }).then(
    (addresses) => {
      const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
      if (blocked || addresses.length === 0) {
        const refused: NodeJS.ErrnoException = new Error(
          blocked
            ? `refusing to connect: "${hostname}" resolves to the non-public address ${blocked.address}`
            : `"${hostname}" resolved to no addresses`,
        );
        refused.code = "ENOTFOUND";
        callback(refused);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    },
    (error: NodeJS.ErrnoException) => callback(error),
  );
}

let directAgent: Agent | undefined;

/**
 * The dispatcher a fetch should use. With a proxy configured the global
 * dispatcher (installed by the host's configureOutboundHttp) tunnels the
 * request and the proxy enforces its own egress policy; without one, a
 * dedicated Agent applies the connect-time address guard plus the same
 * happy-eyeballs fallback the host uses elsewhere.
 */
function fetchDispatcher(env: NodeJS.ProcessEnv): Agent | undefined {
  const proxy =
    env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (proxy && proxy.trim() !== "") return undefined;
  directAgent ??= new Agent({
    connect: {
      lookup: guardedLookup,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 300,
    } as unknown as Agent.Options["connect"],
  });
  return directAgent;
}

// ---------------------------------------------------------------------------
// HTML to readable text (dependency-free, agent-grade fidelity)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122", deg: "\u00B0",
  plusmn: "\u00B1", times: "\u00D7", middot: "\u00B7", sect: "\u00A7",
  laquo: "\u00AB", raquo: "\u00BB", micro: "\u00B5",
};

function codePoint(value: number): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/** Strips markup down to readable text, keeping paragraph/list structure. */
export function htmlToText(html: string): { title?: string; text: string } {
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|hr)\s*\/?\s*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|section|article|tr|table|ul|ol|h[1-6]|blockquote|pre|figure|figcaption|footer|header|main|aside|nav|dd|dt|details|summary)\s*>/gi, "\n")
      .replace(/<(p|div|section|article|h[1-6]|blockquote|pre|tr|table)\b[^>]*>/gi, "\n")
      .replace(/<td\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = rawTitle ? decodeEntities(rawTitle).replace(/\s+/g, " ").trim() : "";
  return { ...(title.length > 0 ? { title } : {}), text };
}

// ---------------------------------------------------------------------------
// Tool definitions (shared between manifests and runtime)
// ---------------------------------------------------------------------------

/** A multi-line tool description, one element per line. */
const lines = (...text: readonly string[]): string => text.join("\n");

/** A day, or for paper searches also a month or a bare year. */
const DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const PAPER_DATE_PATTERN = "^\\d{4}(-\\d{2}(-\\d{2})?)?$";

/** Semantic Scholar's fields of study, verbatim. */
export const FIELDS_OF_STUDY = [
  "Computer Science", "Medicine", "Chemistry", "Biology", "Materials Science", "Physics",
  "Geology", "Psychology", "Art", "History", "Geography", "Sociology", "Business",
  "Political Science", "Economics", "Philosophy", "Mathematics", "Engineering",
  "Environmental Science", "Agricultural and Food Sciences", "Education", "Law", "Linguistics",
] as const;

const WEB_SEARCH_DEFINITION = {
  name: "web_search",
  description: lines(
    "Search the open web: documentation, software and code, datasets, organisations, standards, reports and other web pages. Returns title, URL, snippet and, when known, the page date for each result.",
    "Use the tool that fits the question instead:",
    "- scholarly papers, on a topic or one known paper by its title → paper_search (returns DOI, authors, venue, year and citation count, and filters by date, author, category, type and open access);",
    "- a paper you already have a DOI, arXiv ID or PMID for, or its references, citing papers or related papers → paper_details;",
    "- news and current events → news_search;",
    "- the text of a page whose URL you already have → web_fetch.",
    "Operators inside query work on most sources: \"exact phrase\", -word to exclude, OR, site:example.org, filetype:pdf.",
    "Searches are shared and rate-limited across all agents of this run, and a repeated search is answered from the run's cache: write one focused query per fact rather than many rephrasings.",
  ),
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description: "What to search for. Operators: \"exact phrase\", -word to exclude, OR, site:example.org, filetype:pdf.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 5,
        description: "How many results to return.",
      },
      page: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        default: 1,
        description: "Results page for the same query; ask for page 2 only when page 1 was on target but not enough.",
      },
      recency: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        description: "Only results from the last day, week, month or year.",
      },
      date_from: {
        type: "string",
        pattern: DAY_PATTERN,
        description:
          "Only results dated on or after this day, YYYY-MM-DD. Exact where the source filters by date; elsewhere the nearest recency window is searched and dated results outside the range are dropped (undated results are kept).",
      },
      date_to: {
        type: "string",
        pattern: DAY_PATTERN,
        description: "Only results dated on or before this day, YYYY-MM-DD (see date_from).",
      },
      include_domains: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Only results from these domains, subdomains included, e.g. [\"nih.gov\", \"europa.eu\"].",
      },
      exclude_domains: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Never return results from these domains.",
      },
      language: {
        type: "string",
        description: "Content language, ISO 639-1 code such as \"en\" or \"de\".",
      },
      country: {
        type: "string",
        description: "Country for regional ranking, ISO 3166-1 alpha-2 code such as \"DE\" or \"US\"; used where the source ranks by region.",
      },
      file_type: {
        type: "string",
        description: "Only files of this type, e.g. \"pdf\" (web_fetch cannot read PDFs).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

const NEWS_SEARCH_DEFINITION = {
  name: "news_search",
  description: lines(
    "Search news: articles from news outlets and wire services, and press releases, for current events and recent developments. Returns headline, URL, snippet and publication time.",
    "Set recency (or date_from/date_to) when timing matters; results are ranked by relevance, not strictly by date.",
    "For background or reference pages use web_search; for research papers use paper_search; to read an article use web_fetch on its URL.",
  ),
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description: "What to search for; \"exact phrase\" and -word to exclude work.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 5,
        description: "How many articles to return.",
      },
      page: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        default: 1,
        description: "Results page for the same query.",
      },
      recency: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        description: "Only articles from the last day, week, month or year.",
      },
      date_from: {
        type: "string",
        pattern: DAY_PATTERN,
        description: "Only articles published on or after this day, YYYY-MM-DD.",
      },
      date_to: {
        type: "string",
        pattern: DAY_PATTERN,
        description: "Only articles published on or before this day, YYYY-MM-DD.",
      },
      include_domains: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Only articles from these outlets' domains, e.g. [\"reuters.com\", \"apnews.com\"].",
      },
      exclude_domains: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Never return articles from these domains.",
      },
      language: {
        type: "string",
        description: "Article language, ISO 639-1 code such as \"en\".",
      },
      country: {
        type: "string",
        description: "Country edition, ISO 3166-1 alpha-2 code such as \"GB\"; used where the source ranks by region.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

const PAPER_SEARCH_DEFINITION = {
  name: "paper_search",
  description: lines(
    "Find scholarly papers (journal and conference papers, preprints, reviews, books, theses) in OpenAlex, Crossref, arXiv and Semantic Scholar, with web search to locate a known title. Each paper comes with title, authors, year and date, venue, DOI and/or arXiv ID, citation count, open-access PDF link and, where the index has one, the abstract.",
    "mode \"lookup\" finds ONE known paper by its title (put the exact title in query); mode \"topic\" finds papers about a subject; \"auto\" (the default) decides from the query's shape.",
    "Filters are applied inside each index that supports them. The answer lists per index the options it applied (\"applied\"; year_from, year_to, date_from, date_to and last_years appear as date_range) and names every option no index could honour, with the reason (\"notApplied\"). Setting any filter, or a sort other than relevance, searches the scholarly indexes only, not the web.",
    "Where options apply: arxiv — title_contains, abstract_contains, authors, arxiv_categories, dates, sort newest/oldest; openalex — title_contains, abstract_contains, authors, dates, types, open_access_only, min_citations, every sort; crossref — authors, dates, types (no review type), every sort; semantic_scholar — dates, fields_of_study, venues, types (no preprint or thesis type), open_access_only, min_citations, every sort. Options an index cannot apply itself are checked on its returned papers where the record carries the field (title, abstract, authors, date, citations, open access).",
    "Examples:",
    "- arXiv papers from the last 5 years with \"diffusion\" in the title: {\"query\": \"diffusion models for protein design\", \"sources\": [\"arxiv\"], \"title_contains\": [\"diffusion\"], \"last_years\": 5}",
    "- the most-cited reviews since 2020: {\"query\": \"single-cell RNA-seq batch correction\", \"types\": [\"review\"], \"year_from\": 2020, \"sort\": \"most_cited\"}",
    "- one known paper: {\"query\": \"Attention Is All You Need\", \"mode\": \"lookup\"}",
    "Use paper_details instead when you already have a DOI, arXiv ID or PMID, or to get a paper's references, citing papers or related papers. Searches are shared across all agents of this run and repeated searches are answered from the cache.",
  ),
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The topic or question, or for mode \"lookup\" the paper's exact title. Plain words work everywhere; use native_query for an index's own syntax.",
      },
      mode: {
        type: "string",
        enum: ["auto", "topic", "lookup"],
        default: "auto",
        description: "\"lookup\": one known paper by its title. \"topic\": papers about a subject. \"auto\": decided from the query.",
      },
      title_contains: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Words or \"quoted phrases\" that must all appear in the title.",
      },
      abstract_contains: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Words or \"quoted phrases\" that must all appear in the abstract (only papers whose index provides an abstract can match).",
      },
      authors: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Author names, e.g. [\"Geoffrey Hinton\"]; every listed author must be on the paper (compared by surname).",
      },
      year_from: {
        type: "integer",
        minimum: 1600,
        maximum: 2100,
        description: "Published in or after this year.",
      },
      year_to: {
        type: "integer",
        minimum: 1600,
        maximum: 2100,
        description: "Published in or before this year.",
      },
      date_from: {
        type: "string",
        pattern: PAPER_DATE_PATTERN,
        description: "Published on or after this date: YYYY-MM-DD, YYYY-MM or YYYY. Takes precedence over year_from and last_years.",
      },
      date_to: {
        type: "string",
        pattern: PAPER_DATE_PATTERN,
        description: "Published on or before this date: YYYY-MM-DD, YYYY-MM or YYYY. Takes precedence over year_to.",
      },
      last_years: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Only papers published in the last N years, counted back from today (e.g. 5).",
      },
      sources: {
        type: "array",
        items: { type: "string", enum: ["arxiv", "openalex", "crossref", "semantic_scholar", "web"] },
        maxItems: 5,
        description:
          "Search only these; several are searched together and merged. arxiv: preprints in physics, mathematics, computer science, quantitative biology and finance, statistics, electrical engineering and economics. openalex: works from all fields, with citation counts and open-access status. crossref: publishers' DOI records. semantic_scholar: papers from all fields, with citation counts and fields of study. web: general web search, best for locating a known title. Omit to let the mode choose, with failover.",
      },
      arxiv_categories: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "arXiv categories such as \"cs.LG\", \"stat.ML\", \"q-bio.GN\" or \"astro-ph.CO\" (any of them); searches arXiv first.",
      },
      fields_of_study: {
        type: "array",
        items: { type: "string", enum: FIELDS_OF_STUDY },
        maxItems: 10,
        description: "Semantic Scholar fields of study (any of them); searches Semantic Scholar first.",
      },
      venues: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Journal or conference names (any of them), e.g. [\"Nature\", \"NeurIPS\"]; applied by Semantic Scholar.",
      },
      types: {
        type: "array",
        items: {
          type: "string",
          enum: ["journal_article", "conference_paper", "preprint", "review", "book", "book_chapter", "dataset", "thesis"],
        },
        maxItems: 8,
        description: "Publication types (any of them).",
      },
      open_access_only: {
        type: "boolean",
        description: "Only papers with a free full text.",
      },
      min_citations: {
        type: "integer",
        minimum: 1,
        description: "Only papers cited at least this many times.",
      },
      sort: {
        type: "string",
        enum: ["relevance", "newest", "oldest", "most_cited"],
        default: "relevance",
        description: "Result order.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 25,
        default: 10,
        description: "How many papers to return.",
      },
      page: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 1,
        description: "Results page for the same search.",
      },
      native_query: {
        type: "object",
        properties: {
          source: {
            type: "string",
            enum: ["arxiv", "openalex", "crossref", "semantic_scholar"],
            description: "The index to send the query to.",
          },
          query: {
            type: "string",
            minLength: 1,
            description: "The query in that index's own syntax.",
          },
        },
        required: ["source", "query"],
        additionalProperties: false,
        description:
          "Advanced: a query in one index's own syntax, sent unchanged to that index only and combined with the other options it applies. arxiv: search_query syntax, e.g. ti:\"graph neural\" AND cat:cs.LG AND submittedDate:[202101010000 TO 202512312359]. openalex: a filter expression, e.g. title.search:diffusion,publication_year:2021-2025,type:article. crossref: extra query parameters, e.g. query.author=Hinton&filter=type:journal-article. semantic_scholar: bulk-search syntax, e.g. +\"graph neural\" +molecule -survey.",
      },
    },
    additionalProperties: false,
  },
} as const;

const PAPER_DETAILS_DEFINITION = {
  name: "paper_details",
  description: lines(
    "Look up papers you already have an identifier for, and follow the citation graph. Accepts DOIs (10.1038/nature14539), arXiv IDs (1706.03762, hep-th/9901001), PMID:12345678, PMCIDs (PMC1234567), Semantic Scholar paper IDs (40 hex characters or CorpusId:123), OpenAlex work IDs (W2741809807) and doi.org, arxiv.org, pubmed, openalex.org or semanticscholar.org URLs; up to 20 per call.",
    "Returns each paper's metadata (title, authors, date, venue, identifiers, citation count, open-access PDF link) and, as requested in include: its abstract, its references, the papers citing it (most-cited first where the index can sort), and related papers.",
    "Use it instead of fetching api.openalex.org, api.crossref.org, api.semanticscholar.org or export.arxiv.org yourself. To find papers without an identifier, use paper_search.",
  ),
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        maxItems: 20,
        description: "Paper identifiers or URLs, in any of the forms listed above.",
      },
      include: {
        type: "array",
        items: { type: "string", enum: ["abstract", "references", "citations", "related"] },
        maxItems: 4,
        default: ["abstract"],
        description: "What to add to the metadata: abstract, references (the papers it cites), citations (papers citing it), related (similar papers).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 20,
        description: "Maximum papers per list (references, citations, related).",
      },
    },
    required: ["ids"],
    additionalProperties: false,
  },
} as const;

const WEB_FETCH_DEFINITION = {
  name: "web_fetch",
  description: lines(
    "Fetch one public http(s) URL and return its readable text (HTML is converted to plain text, the page title is included when present). Use it to read a page found with web_search, news_search or paper_search.",
    "Only textual content is supported — PDFs and other binary types are refused; for a paper, fetch its HTML page (e.g. the arXiv abstract page) or get the abstract from paper_details. The text is truncated to max_chars.",
    "Do not use it to run searches (use the search tools) or to query scholarly APIs (use paper_search and paper_details).",
  ),
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public http(s) URL to retrieve." },
      max_chars: {
        type: "integer",
        description: "Maximum characters to return.",
        minimum: 1000,
        maximum: 48000,
        default: 12000,
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
} as const;

export const WEB_SEARCH_MANIFEST: HostToolManifest = {
  toolId: "web_search",
  displayName: "Web Search",
  operations: ["web.search"],
  risk: "medium",
  defaultEnabled: false,
  definition: WEB_SEARCH_DEFINITION,
};

export const WEB_FETCH_MANIFEST: HostToolManifest = {
  toolId: "web_fetch",
  displayName: "Web Fetch",
  operations: ["web.fetch"],
  risk: "medium",
  defaultEnabled: false,
  definition: WEB_FETCH_DEFINITION,
};

export const NEWS_SEARCH_MANIFEST: HostToolManifest = {
  toolId: "news_search",
  displayName: "News Search",
  operations: ["web.search"],
  risk: "medium",
  defaultEnabled: false,
  definition: NEWS_SEARCH_DEFINITION,
};

export const PAPER_SEARCH_MANIFEST: HostToolManifest = {
  toolId: "paper_search",
  displayName: "Paper Search",
  operations: ["web.search"],
  risk: "medium",
  defaultEnabled: false,
  definition: PAPER_SEARCH_DEFINITION,
};

export const PAPER_DETAILS_MANIFEST: HostToolManifest = {
  toolId: "paper_details",
  displayName: "Paper Details",
  operations: ["web.search"],
  risk: "medium",
  defaultEnabled: false,
  definition: PAPER_DETAILS_DEFINITION,
};

/**
 * Every web tool. Each search tool serves the one web.search operation, and
 * the broker offers ALL enabled tools for an operation, so a task holding
 * the web-search capability sees the full set and picks by description.
 */
export const WEB_SEARCH_MANIFESTS: readonly HostToolManifest[] = [
  WEB_SEARCH_MANIFEST,
  WEB_FETCH_MANIFEST,
  NEWS_SEARCH_MANIFEST,
  PAPER_SEARCH_MANIFEST,
  PAPER_DETAILS_MANIFEST,
];

// ---------------------------------------------------------------------------
// web_fetch tool
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 12_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 48_000;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export const WEB_FETCH_TOOL_NAMES = ["web_fetch"] as const;

export interface WebFetchOptions {
  /**
   * Test seam: permit loopback/private targets and non-default ports so
   * suites can fetch from local fixture servers. Production callers omit it.
   */
  readonly allowPrivateAddresses?: boolean;
  /** Overall budget for one fetch, redirects included. Test seam. */
  readonly timeoutMs?: number;
  /** Download cap in bytes. Test seam. */
  readonly maxBytes?: number;
  /** Environment consulted for proxy configuration. Test seam. */
  readonly env?: NodeJS.ProcessEnv;
}

function ok(output: JsonValue): ToolResult {
  return { output };
}

function refusal(message: string): ToolResult {
  return { output: message, isError: true };
}

function inputRecord(value: JsonValue): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function clampChars(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, value));
}

/** Static URL validation: scheme, credentials, port, and literal addresses. */
function validateTarget(
  raw: string,
  allowPrivate: boolean,
): { url: URL } | { message: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { message: `"${raw}" is not a valid absolute URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { message: `only http(s) URLs are fetched, got "${url.protocol}//".` };
  }
  if (url.username !== "" || url.password !== "") {
    return { message: "URLs with embedded credentials are not fetched." };
  }
  if (allowPrivate) return { url };
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    return { message: "only the default http(s) ports are fetched." };
  }
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0 && !isPublicAddress(bare)) {
    return { message: `"${bare}" is not a public address.` };
  }
  if (isInternalHostname(bare)) {
    return { message: `"${url.hostname}" names an internal service.` };
  }
  return { url };
}

/**
 * DNS pre-flight: every address the hostname resolves to must be public.
 * Behind a proxy an unresolvable name is allowed through (clusters often
 * resolve only via the proxy), but a name that DOES resolve to a private
 * address is refused either way.
 */
async function assertPublicHost(url: URL, proxied: boolean): Promise<string | undefined> {
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) {
    return isPublicAddress(bare) ? undefined : `"${bare}" is not a public address.`;
  }
  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(bare, { all: true, verbatim: true });
  } catch {
    return proxied ? undefined : `"${url.hostname}" could not be resolved.`;
  }
  const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
  return blocked
    ? `"${url.hostname}" resolves to the non-public address ${blocked.address}.`
    : undefined;
}

/** Reads the body up to `maxBytes`; breaking out cancels the stream. */
async function readBounded(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (size + piece.length > maxBytes) {
      chunks.push(piece.subarray(0, maxBytes - size));
      return { buffer: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(piece);
    size += piece.length;
  }
  return { buffer: Buffer.concat(chunks), truncated: false };
}

function decodeBody(buffer: Buffer, contentType: string): string {
  const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.replace(/["']/g, "");
  try {
    return new TextDecoder(charset ?? "utf-8", { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

/** Textual content types the fetcher renders; everything else is refused. */
function isTextual(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    type === "" // servers that omit the header get the binary sniff below
  );
}

function isHtml(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

/** One fetch's outcome: the delivered answer, or the refusal the model hears. */
export type WebFetchOutcome =
  | { readonly ok: WebFetchAnswer }
  | { readonly refusal: string };

/**
 * THE web fetch implementation — exactly one exists. The web_fetch host tool
 * wraps it for the Messages path, and the WebAccessManager wraps it for the
 * unified (logged, concurrency-bounded) layer every backend shares. A second
 * fetch path would fork the SSRF guard, so keep every caller on this one.
 *
 * Returns a refusal (what the model is told) for every anticipated failure;
 * throws only when `signal` reports an external cancellation.
 */
export async function performWebFetch(
  input: { readonly url: string; readonly maxChars?: number },
  options: WebFetchOptions = {},
  signal?: AbortSignal,
): Promise<WebFetchOutcome> {
  const allowPrivate = options.allowPrivateAddresses === true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const rawUrl = input.url;
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { refusal: "url must be a non-empty string." };
  }
  const maxChars = clampChars(input.maxChars);

  const env = options.env ?? process.env;
  // A returned Agent means a direct connection (with the connect-time
  // guard); undefined means the process's proxy dispatcher does the
  // egress. The test seam bypasses both and uses plain fetch.
  const dispatcher = allowPrivate ? undefined : fetchDispatcher(env);
  const proxied = !allowPrivate && dispatcher === undefined;

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let target = validateTarget(rawUrl.trim(), allowPrivate);
  if ("message" in target) return { refusal: target.message };
  let current = target.url;
  let response: Awaited<ReturnType<typeof httpFetch>> | undefined;

  try {
    for (let hop = 0; ; hop += 1) {
      if (!allowPrivate) {
        const blocked = await assertPublicHost(current, proxied);
        if (blocked) return { refusal: blocked };
      }
      response = await httpFetch(current.toString(), {
        ...(dispatcher ? { dispatcher } : {}),
        redirect: "manual",
        signal: combined,
        headers: {
          "user-agent": "brainstorm-agentic/0.2 (research assistant)",
          accept:
            "text/html, application/xhtml+xml, text/plain;q=0.9, application/json;q=0.8, */*;q=0.1",
          "accept-language": "en",
        },
      });
      const location = response.headers.get("location");
      if (
        response.status < 300 ||
        response.status >= 400 ||
        location === null
      ) {
        break;
      }
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) {
        return { refusal: `gave up after ${MAX_REDIRECTS} redirects at ${current.toString()}` };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { refusal: `redirect to an invalid URL: "${location}"` };
      }
      target = validateTarget(next.toString(), allowPrivate);
      if ("message" in target) {
        return { refusal: `redirect refused: ${target.message}` };
      }
      current = target.url;
    }

    if (response.status >= 400) {
      await response.body?.cancel().catch(() => undefined);
      return { refusal: `HTTP ${response.status} fetching ${current.toString()}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!isTextual(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        refusal:
          `unsupported content type "${contentType.split(";")[0]!.trim()}" — only textual content (HTML, plain text, JSON, XML) is fetched.`,
      };
    }

    const { buffer, truncated: bytesTruncated } = response.body
      ? await readBounded(response.body as AsyncIterable<Uint8Array>, maxBytes)
      : { buffer: Buffer.alloc(0), truncated: false };
    const decoded = decodeBody(buffer, contentType);
    if (decoded.includes("\u0000")) {
      return { refusal: "the response is binary data, not text." };
    }

    const rendered = isHtml(contentType)
      ? htmlToText(decoded)
      : { text: decoded.replace(/\r\n/g, "\n").trim() };
    const charsTruncated = rendered.text.length > maxChars;
    return {
      ok: {
        url: rawUrl.trim(),
        finalUrl: current.toString(),
        status: response.status,
        contentType: contentType.split(";")[0]!.trim(),
        ...(rendered.title !== undefined ? { title: rendered.title } : {}),
        text: charsTruncated ? rendered.text.slice(0, maxChars) : rendered.text,
        truncated: bytesTruncated || charsTruncated,
        fetchedBytes: buffer.length,
      },
    };
  } catch (error) {
    // A cancelled run propagates; the executor converts it upstream.
    if (signal?.aborted) throw error;
    if (timeout.aborted) {
      return {
        refusal: `fetch timed out after ${Math.round(timeoutMs / 1000)}s: ${current.toString()}`,
      };
    }
    const cause = (error as { cause?: unknown }).cause;
    const message =
      cause instanceof Error
        ? cause.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { refusal: `fetch failed for ${current.toString()}: ${message}` };
  }
}

/** The executable web_fetch tool (a thin wrapper over performWebFetch). */
export function webFetchTools(options: WebFetchOptions = {}): readonly Tool[] {
  const fetchTool: Tool = {
    definition: WEB_FETCH_DEFINITION,
    async execute(input, context): Promise<ToolResult> {
      const record = inputRecord(input);
      const rawUrl = record.url;
      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        return refusal("url must be a non-empty string.");
      }
      const outcome = await performWebFetch(
        {
          url: rawUrl,
          ...(typeof record.max_chars === "number" ? { maxChars: record.max_chars } : {}),
        },
        options,
        context.signal,
      );
      if ("refusal" in outcome) return refusal(outcome.refusal);
      return ok(outcome.ok as unknown as JsonValue);
    },
  };

  return [fetchTool];
}
