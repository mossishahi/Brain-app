import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderRequestError,
  arxivProvider,
  braveProvider,
  crossrefProvider,
  offlineSearchProvider,
  openAlexProvider,
  searxngProvider,
  semanticScholarProvider,
  tavilyProvider,
  type ProviderFetch,
} from "../src/index.js";

/** One canned HTTP answer, capturing what was requested. */
function fetchReturning(
  body: string,
  captured: { url?: string; init?: Parameters<ProviderFetch>[1] } = {},
  status = 200,
): ProviderFetch {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    return {
      status,
      headers: { get: () => null },
      text: async () => body,
    };
  };
}

test("tavily: request shape and response parsing", async () => {
  const captured: { url?: string; init?: Parameters<ProviderFetch>[1] } = {};
  const provider = tavilyProvider({
    apiKey: "tvly-key",
    fetchImpl: fetchReturning(
      JSON.stringify({
        query: "q",
        results: [
          {
            title: "Result one",
            url: "https://example.org/one",
            content: "Snippet <b>text</b>",
            score: 0.91,
            published_date: "2026-01-02",
          },
          { title: "No URL means dropped" },
        ],
      }),
      captured,
    ),
  });
  const answer = await provider.search({
    query: "q",
    kind: "news",
    maxResults: 4,
    recency: "week",
    domains: ["example.org"],
  });
  assert.equal(captured.url, "https://api.tavily.com/search");
  assert.equal(captured.init?.method, "POST");
  assert.equal(captured.init?.headers?.authorization, "Bearer tvly-key");
  const body = JSON.parse(captured.init?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.query, "q");
  assert.equal(body.topic, "news");
  assert.equal(body.time_range, "week");
  assert.deepEqual(body.include_domains, ["example.org"]);
  assert.equal(answer.hits.length, 1);
  assert.deepEqual(answer.hits[0], {
    title: "Result one",
    url: "https://example.org/one",
    snippet: "Snippet text",
    source: "tavily",
    score: 0.91,
    published: "2026-01-02",
  });
});

test("brave: subscription header, freshness code, and web/news ordering", async () => {
  const captured: { url?: string; init?: Parameters<ProviderFetch>[1] } = {};
  const provider = braveProvider({
    apiKey: "brave-key",
    fetchImpl: fetchReturning(
      JSON.stringify({
        web: {
          results: [
            { title: "Web hit", url: "https://example.org/w", description: "w" },
          ],
        },
        news: {
          results: [
            { title: "News hit", url: "https://example.org/n", description: "n", age: "2 days ago" },
          ],
        },
      }),
      captured,
    ),
  });
  const answer = await provider.search({ query: "brave q", kind: "news", maxResults: 5, recency: "month" });
  const url = new URL(captured.url!);
  assert.equal(url.searchParams.get("q"), "brave q");
  assert.equal(url.searchParams.get("freshness"), "pm");
  assert.equal(captured.init?.headers?.["x-subscription-token"], "brave-key");
  // A news query reads the news section first.
  assert.equal(answer.hits[0]!.title, "News hit");
  assert.equal(answer.hits[0]!.published, "2 days ago");
});

test("searxng: keyless self-hosted metasearch with json format", async () => {
  const captured: { url?: string } = {};
  const provider = searxngProvider({
    baseUrl: "http://searx.internal:8080/",
    fetchImpl: fetchReturning(
      JSON.stringify({
        results: [
          { title: "S", url: "https://example.org/s", content: "c", engine: "duckduckgo" },
        ],
      }),
      captured,
    ),
  });
  const answer = await provider.search({ query: "sx", kind: "general", maxResults: 3 });
  const url = new URL(captured.url!);
  assert.equal(url.origin + url.pathname, "http://searx.internal:8080/search");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("categories"), "general");
  assert.equal(answer.hits[0]!.source, "searxng");
  assert.equal(answer.engineFailures, undefined, "no failures block when every engine answered");
});

test("searxng: engines that failed inside the answer are named with their cause", async () => {
  const provider = searxngProvider({
    baseUrl: "http://searx.internal:8080",
    fetchImpl: fetchReturning(
      JSON.stringify({
        results: [
          { title: "S", url: "https://example.org/s", content: "c", engine: "duckduckgo" },
        ],
        // The wire shape: [engine, reason] pairs (newer builds may append more).
        unresponsive_engines: [
          ["google", "CAPTCHA"],
          ["startpage", "timeout", true],
          ["malformed-entry"],
        ],
      }),
    ),
  });
  const answer = await provider.search({ query: "sx", kind: "general", maxResults: 3 });
  assert.deepEqual(answer.engineFailures, [
    { engine: "google", reason: "CAPTCHA" },
    { engine: "startpage", reason: "timeout" },
    { engine: "malformed-entry", reason: "unresponsive" },
  ]);
});

test("openalex: scholarly enrichment — DOI, authors, venue, year, citations, abstract", async () => {
  const captured: { url?: string } = {};
  const provider = openAlexProvider({
    apiKey: "oa-key",
    contactEmail: "team@example.org",
    fetchImpl: fetchReturning(
      JSON.stringify({
        meta: { count: 421 },
        results: [
          {
            id: "https://openalex.org/W1",
            display_name: "A landmark work",
            doi: "https://doi.org/10.1234/xyz",
            publication_year: 2024,
            cited_by_count: 321,
            authorships: [
              { author: { display_name: "Ada Lovelace" } },
              { author: { display_name: "Alan Turing" } },
            ],
            primary_location: {
              landing_page_url: "https://journal.example.org/a",
              source: { display_name: "Journal of Examples" },
            },
            abstract_inverted_index: { Deep: [0], learning: [1], works: [2] },
          },
        ],
      }),
      captured,
    ),
  });
  const answer = await provider.search({ query: "deep learning", kind: "scholarly", maxResults: 5 });
  const url = new URL(captured.url!);
  assert.equal(url.searchParams.get("search"), "deep learning");
  assert.equal(url.searchParams.get("api_key"), "oa-key");
  assert.equal(url.searchParams.get("mailto"), "team@example.org");
  assert.equal(answer.total, 421);
  const hit = answer.hits[0]!;
  assert.equal(hit.doi, "10.1234/xyz");
  assert.equal(hit.url, "https://doi.org/10.1234/xyz");
  assert.deepEqual(hit.authors, ["Ada Lovelace", "Alan Turing"]);
  assert.equal(hit.venue, "Journal of Examples");
  assert.equal(hit.year, 2024);
  assert.equal(hit.citations, 321);
  assert.equal(hit.snippet, "Deep learning works");
});

test("crossref: JATS abstract stripped, issued year and container title read", async () => {
  const provider = crossrefProvider({
    fetchImpl: fetchReturning(
      JSON.stringify({
        message: {
          "total-results": 7,
          items: [
            {
              DOI: "10.5/abc",
              URL: "https://doi.org/10.5/abc",
              title: ["Crossref title"],
              abstract: "<jats:p>An abstract.</jats:p>",
              author: [{ given: "Grace", family: "Hopper" }],
              issued: { "date-parts": [[2023, 5]] },
              "container-title": ["Proceedings of Examples"],
              "is-referenced-by-count": 12,
            },
          ],
        },
      }),
    ),
  });
  const answer = await provider.search({ query: "x", kind: "scholarly", maxResults: 3 });
  const hit = answer.hits[0]!;
  assert.equal(answer.total, 7);
  assert.equal(hit.title, "Crossref title");
  assert.equal(hit.snippet, "An abstract.");
  assert.deepEqual(hit.authors, ["Grace Hopper"]);
  assert.equal(hit.year, 2023);
  assert.equal(hit.venue, "Proceedings of Examples");
  assert.equal(hit.citations, 12);
});

test("arxiv: Atom entries parsed with authors, dates, and a politeness floor", async () => {
  const provider = arxivProvider({
    fetchImpl: fetchReturning(
      `<?xml version="1.0"?><feed>
        <entry>
          <id>http://arxiv.org/abs/2401.00001v1</id>
          <title>An arXiv  paper</title>
          <summary>The summary text.</summary>
          <published>2024-01-15T00:00:00Z</published>
          <author><name>First Author</name></author>
          <author><name>Second Author</name></author>
        </entry>
      </feed>`,
    ),
  });
  assert.ok((provider.minIntervalMs ?? 0) >= 3000, "arXiv asks for one call per 3s");
  const answer = await provider.search({ query: "quantum", kind: "scholarly", maxResults: 2 });
  const hit = answer.hits[0]!;
  assert.equal(hit.title, "An arXiv paper");
  assert.equal(hit.url, "http://arxiv.org/abs/2401.00001v1");
  assert.equal(hit.snippet, "The summary text.");
  assert.deepEqual(hit.authors, ["First Author", "Second Author"]);
  assert.equal(hit.year, 2024);
  assert.equal(hit.venue, "arXiv");
});

test("semantic scholar: fields requested, DOI fallback URL, keyed header", async () => {
  const captured: { url?: string; init?: Parameters<ProviderFetch>[1] } = {};
  const provider = semanticScholarProvider({
    apiKey: "s2-key",
    fetchImpl: fetchReturning(
      JSON.stringify({
        total: 3,
        data: [
          {
            title: "S2 paper",
            abstract: "Abs.",
            year: 2022,
            venue: "NeurIPS",
            citationCount: 99,
            externalIds: { DOI: "10.9/s2" },
            authors: [{ name: "Person One" }],
          },
        ],
      }),
      captured,
    ),
  });
  const answer = await provider.search({ query: "s2", kind: "scholarly", maxResults: 2 });
  const url = new URL(captured.url!);
  assert.ok(url.pathname.endsWith("/graph/v1/paper/search"));
  assert.match(url.searchParams.get("fields") ?? "", /citationCount/);
  assert.equal(captured.init?.headers?.["x-api-key"], "s2-key");
  assert.equal(answer.hits[0]!.url, "https://doi.org/10.9/s2");
  assert.equal(answer.hits[0]!.citations, 99);
});

test("upstream 429/5xx raise retryable errors; 401 raises a non-retryable one naming the fix", async () => {
  const throttled = tavilyProvider({
    apiKey: "k",
    fetchImpl: fetchReturning("{}", {}, 429),
  });
  await assert.rejects(
    throttled.search({ query: "q", kind: "general", maxResults: 1 }),
    (error: Error) => error instanceof ProviderRequestError && error.retryable,
  );
  const refused = braveProvider({
    apiKey: "bad",
    fetchImpl: fetchReturning("{}", {}, 401),
  });
  await assert.rejects(
    refused.search({ query: "q", kind: "general", maxResults: 1 }),
    (error: Error) =>
      error instanceof ProviderRequestError &&
      !error.retryable &&
      /check it in Settings/.test(error.message),
  );
});

test("the offline provider is deterministic per kind+query", async () => {
  const provider = offlineSearchProvider();
  const first = await provider.search({ query: "same", kind: "general", maxResults: 3 });
  const second = await provider.search({ query: "same", kind: "general", maxResults: 3 });
  assert.deepEqual(first, second);
  const other = await provider.search({ query: "same", kind: "scholarly", maxResults: 3 });
  assert.notDeepEqual(first.hits[0]!.url, other.hits[0]!.url);
});
