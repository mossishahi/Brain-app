/**
 * The literature-retrieval backends added for the paper-based panel
 * composition (Europe PMC, CORE, OpenCitations): request shape, parsing,
 * the key gate, the explicit index list of paper_details, and the status
 * table. No test touches the network.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PaperDetailPart, PaperDetailsEntry } from "@brainstorm-agentic/core";

import {
  WebAccessManager,
  buildWebAccessManager,
  coreBackend,
  europePmcBackend,
  openCitationsBackend,
  type ProviderFetch,
} from "../src/index.js";
import type { NormalizedPaperQuery, PaperBackend, PaperIdentifier } from "../src/web/scholarly.js";

/** One canned HTTP answer, capturing what was requested. */
function fetchReturning(
  body: string,
  captured: { url?: string; init?: Parameters<ProviderFetch>[1]; calls?: number } = {},
  status = 200,
): ProviderFetch {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    captured.calls = (captured.calls ?? 0) + 1;
    return {
      status,
      headers: { get: () => null },
      text: async () => body,
    };
  };
}

/** Answers by URL, recording every URL asked for. */
function fetchByUrl(answers: (url: string) => string, urls: string[], headers: unknown[] = []): ProviderFetch {
  return async (url, init) => {
    urls.push(url);
    headers.push(init?.headers);
    return { status: 200, headers: { get: () => null }, text: async () => answers(url) };
  };
}

function normalized(overrides: Partial<NormalizedPaperQuery> = {}): NormalizedPaperQuery {
  return {
    query: "",
    mode: "topic",
    titleContains: [],
    abstractContains: [],
    authors: [],
    arxivCategories: [],
    fieldsOfStudy: [],
    venues: [],
    types: [],
    openAccessOnly: false,
    sort: "relevance",
    maxResults: 25,
    page: 1,
    ...overrides,
  };
}

test("europepmc: query syntax, date window and open-access filter, response parsing, abstract cap", async () => {
  const captured: { url?: string; init?: Parameters<ProviderFetch>[1] } = {};
  const longAbstract = `<p>${"word ".repeat(1_000)}</p>`;
  const backend = europePmcBackend({
    fetchImpl: fetchReturning(
      JSON.stringify({
        hitCount: 2,
        resultList: {
          result: [
            {
              id: "12345",
              source: "MED",
              pmid: "12345",
              pmcid: "pmc999",
              doi: "10.1000/ABC",
              title: "Gaussian belief propagation on <i>factor graphs</i>.",
              authorString: "Smith J, Doe A.",
              pubYear: "2021",
              firstPublicationDate: "2021-03-04",
              journalInfo: { journal: { title: "J Stat" } },
              isOpenAccess: "Y",
              citedByCount: 7,
              pubType: "research-article",
              abstractText: longAbstract,
            },
            { id: "no-title" },
          ],
        },
      }),
      captured,
    ),
  });
  assert.deepEqual(backend.ready, { ok: true });
  assert.equal(backend.id, "europepmc");
  // Availability change set (2026-10-03): the source now has a known-answer
  // probe for the launch check and the availability service.
  assert.equal(typeof backend.check, "function");
  const answer = await backend.search(
    normalized({ query: 'message passing: (gaussian) "factor graph', dateFrom: "2015-01-01", openAccessOnly: true, maxResults: 10 }),
  );
  const url = new URL(captured.url!);
  assert.equal(`${url.origin}${url.pathname}`, "https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  assert.equal(url.searchParams.get("query"), "(message passing gaussian factor graph) AND FIRST_PDATE:[2015-01-01 TO 3000-12-31] AND OPEN_ACCESS:y");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("resultType"), "core");
  assert.equal(url.searchParams.get("pageSize"), "10");
  assert.equal(captured.init?.method, "GET");
  assert.equal(answer.total, 2);
  assert.equal(answer.papers.length, 1);
  const paper = answer.papers[0]!;
  assert.equal(paper.title, "Gaussian belief propagation on factor graphs");
  assert.equal(paper.doi, "10.1000/abc");
  assert.equal(paper.url, "https://doi.org/10.1000/abc");
  assert.deepEqual(paper.authors, ["Smith J", "Doe A"]);
  assert.equal(paper.year, 2021);
  assert.equal(paper.date, "2021-03-04");
  assert.equal(paper.venue, "J Stat");
  assert.equal(paper.pmid, "12345");
  assert.equal(paper.pmcid, "PMC999");
  assert.equal(paper.openAccess, true);
  assert.equal(paper.citations, 7);
  assert.equal(paper.source, "europepmc");
  assert.equal(paper.abstract!.length, 4_000);
  assert.ok(paper.abstract!.endsWith("…"));
  assert.ok(!paper.abstract!.includes("<p>"));
  assert.ok(answer.applied.includes("date_range") && answer.applied.includes("open_access_only"));
});

test("europepmc: a lookup searches the title as a phrase; an empty question sends nothing", async () => {
  const captured: { url?: string; calls?: number } = {};
  const backend = europePmcBackend({ fetchImpl: fetchReturning(JSON.stringify({ resultList: { result: [] } }), captured) });
  await backend.search(normalized({ query: "A visual introduction", mode: "lookup", sort: "newest" }));
  const url = new URL(captured.url!);
  assert.equal(url.searchParams.get("query"), 'TITLE:"A visual introduction"');
  assert.equal(url.searchParams.get("sort"), "P_PDATE_D desc");
  const calls = captured.calls;
  const empty = await backend.search(normalized({ query: "  " }));
  assert.equal(captured.calls, calls, "no request for an empty query");
  assert.deepEqual(empty.papers, []);
  assert.equal(empty.unsupported[0]!.option, "query");
});

test("core: without a key the source needs one and sends nothing", async () => {
  const captured: { calls?: number } = {};
  const backend = coreBackend({ fetchImpl: fetchReturning("{}", captured) });
  assert.equal(backend.ready.ok, false);
  assert.match((backend.ready as { reason: string }).reason, /API key/);
  const answer = await backend.search(normalized({ query: "factor graphs" }));
  assert.equal(captured.calls, undefined);
  assert.deepEqual(answer.papers, []);
  assert.equal(coreBackend({ apiKey: "   " }).ready.ok, false, "a blank key is no key");
});

test("core: bearer key, q syntax, paging offset, response parsing", async () => {
  const captured: { url?: string; init?: Parameters<ProviderFetch>[1] } = {};
  const backend = coreBackend({
    apiKey: " core-key ",
    fetchImpl: fetchReturning(
      JSON.stringify({
        totalHits: 1,
        results: [
          {
            id: 4242,
            title: "Belief propagation for Gaussian graphical models",
            doi: "https://doi.org/10.1000/XYZ",
            arxivId: "2101.00001v3",
            authors: [{ name: "Ada Lovelace" }, { nothing: true }],
            yearPublished: 2020,
            publishedDate: "2020-05-06T00:00:00",
            journals: [{ title: "Proc. ML" }],
            downloadUrl: "https://core.ac.uk/download/4242.pdf",
            documentType: "research",
            abstract: "An abstract.",
          },
        ],
      }),
      captured,
    ),
  });
  assert.deepEqual(backend.ready, { ok: true });
  const answer = await backend.search(normalized({ query: "gaussian [belief] propagation", dateFrom: "2015-01-01", page: 2, maxResults: 25 }));
  const url = new URL(captured.url!);
  assert.equal(`${url.origin}${url.pathname}`, "https://api.core.ac.uk/v3/search/works");
  assert.equal(url.searchParams.get("q"), "(gaussian belief propagation) AND yearPublished>=2015");
  assert.equal(url.searchParams.get("limit"), "25");
  assert.equal(url.searchParams.get("offset"), "25");
  assert.equal((captured.init?.headers as Record<string, string>).authorization, "Bearer core-key");
  const paper = answer.papers[0]!;
  assert.equal(paper.coreId, "4242");
  assert.equal(paper.doi, "10.1000/xyz");
  assert.equal(paper.arxivId, "2101.00001");
  assert.deepEqual(paper.authors, ["Ada Lovelace"]);
  assert.equal(paper.year, 2020);
  assert.equal(paper.date, "2020-05-06");
  assert.equal(paper.venue, "Proc. ML");
  assert.equal(paper.openAccess, true);
  assert.equal(paper.source, "core");
  assert.equal(paper.abstract, "An abstract.");
  assert.ok(answer.applied.includes("page"));
});

test("opencitations: references and citations by DOI, identifiers parsed, deduplicated and limited; no search", async () => {
  const urls: string[] = [];
  const headers: unknown[] = [];
  const backend = openCitationsBackend({
    accessToken: "oc-token",
    fetchImpl: fetchByUrl(
      (url) =>
        url.includes("/references/")
          ? JSON.stringify([
              { cited: "omid:br/1 doi:10.1/A openalex:w11 pmid:99" },
              { cited: "omid:br/2 doi:10.1/a" },
              { cited: "omid:br/3" },
              { cited: "omid:br/4 doi:10.1/B" },
              { cited: "doi:10.1/C" },
            ])
          : JSON.stringify([{ citing: "doi:10.2/Z" }]),
      urls,
      headers,
    ),
  });
  assert.equal(typeof backend.check, "function");
  const ids: PaperIdentifier[] = [
    { raw: "10.1109/TIT.2005.850085", kind: "doi", value: "10.1109/tit.2005.850085" },
    { raw: "2101.00001", kind: "arxiv", value: "2101.00001" },
  ];
  const found = await backend.details!(ids, new Set<PaperDetailPart>(["references", "citations"]), 2);
  assert.deepEqual(urls, [
    "https://api.opencitations.net/index/v2/references/doi:10.1109/tit.2005.850085",
    "https://api.opencitations.net/index/v2/citations/doi:10.1109/tit.2005.850085",
  ]);
  assert.equal((headers[0] as Record<string, string>).authorization, "oc-token");
  assert.equal(found.size, 1, "only DOIs are resolved");
  const entry = found.get("10.1109/TIT.2005.850085")!;
  assert.deepEqual(
    entry.references!.map((paper) => [paper.doi, paper.openAlexId, paper.pmid]),
    [
      ["10.1/a", "W11", "99"],
      ["10.1/b", undefined, undefined],
    ],
  );
  assert.deepEqual(entry.citedBy!.map((paper) => paper.doi), ["10.2/z"]);
  const search = await backend.search(normalized({ query: "anything" }));
  assert.deepEqual(search.papers, []);
  assert.equal(urls.length, 2, "search sends nothing");
});

/** A details-only fake index that counts its calls. */
function fakeDetailsBackend(id: "semantic-scholar" | "opencitations", calls: string[]): PaperBackend {
  return {
    id,
    ready: { ok: true },
    async search() {
      return { papers: [], applied: [], unsupported: [] };
    },
    async details(ids: readonly PaperIdentifier[]) {
      calls.push(id);
      const out = new Map<string, PaperDetailsEntry>();
      for (const identifier of ids) {
        out.set(identifier.raw, {
          requested: identifier.raw,
          title: id === "semantic-scholar" ? "Resolved title" : "",
          url: `https://doi.org/${identifier.value}`,
          doi: identifier.value,
          source: id,
          references: [{ title: "", url: "https://doi.org/10.9/r", doi: "10.9/r", source: id }],
        });
      }
      return out;
    },
  };
}

test("paper_details: an explicit index list replaces the route; the default route never consults OpenCitations", async () => {
  const calls: string[] = [];
  const manager = new WebAccessManager({
    providers: [],
    chains: {},
    paperBackends: [fakeDetailsBackend("semantic-scholar", calls), fakeDetailsBackend("opencitations", calls)],
    sleep: async () => {},
  });
  const byDefault = await manager.paperDetails({ ids: ["10.1000/x"], include: ["references"] });
  assert.deepEqual(calls, ["semantic-scholar"]);
  assert.deepEqual(byDefault.providers, ["semantic-scholar"]);
  calls.length = 0;
  const explicit = await manager.paperDetails({ ids: ["10.1000/x"], include: ["references"], sources: ["opencitations"] });
  assert.deepEqual(calls, ["opencitations"]);
  assert.deepEqual(explicit.providers, ["opencitations"]);
  assert.equal(explicit.papers[0]!.source, "opencitations");
});

test("buildWebAccessManager: the status table lists Europe PMC, CORE (needs its key) and OpenCitations", () => {
  const keyless = buildWebAccessManager({ config: {} });
  assert.ok(keyless);
  const states = new Map(keyless.status().map((status) => [status.id, status.state]));
  assert.ok(states.has("europepmc"));
  assert.ok(states.has("opencitations"));
  assert.equal(states.get("core"), "needs-key");
  const keyed = buildWebAccessManager({ config: {}, secrets: { coreApiKey: "core-key" } });
  assert.ok(keyed);
  assert.notEqual(new Map(keyed.status().map((status) => [status.id, status.state])).get("core"), "needs-key");
});
