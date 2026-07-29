/**
 * Stage 2 — Decompose: the literature grounding browser (papers → authors →
 * research interests) and the three-column tree browser over the expertise
 * tree the search grounded.
 */
import { useState } from "react";
import type {
  DecomposeStage,
  ExpertsTreeView,
  GroundingView,
  ScholarView,
} from "@brainstorm-agentic/protocol";

function computeCounts(experts: ExpertsTreeView) {
  return {
    departments: experts.departments.length,
    umbrellas: experts.departments.reduce(
      (sum, department) => sum + department.umbrellas.length,
      0,
    ),
    subfields: experts.departments.reduce(
      (sum, department) =>
        sum +
        department.umbrellas.reduce(
          (nested, umbrella) => nested + umbrella.subfields.length,
          0,
        ),
      0,
    ),
  };
}

/** Fold case, diacritics, and punctuation so bylines match scholar records. */
function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function profileMeta(scholar: ScholarView): string {
  if (scholar.profile === "no_profile") return "no profile found";
  if (scholar.profile === "ambiguous") return "ambiguous identity";
  const parts = [
    scholar.affiliation.length > 0 ? scholar.affiliation : undefined,
    `${scholar.interests.length} interest${scholar.interests.length === 1 ? "" : "s"}`,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" · ");
}

/**
 * Three columns, left to right: retrieved papers, their authors, and the
 * verbatim research interests. Selecting a paper narrows the authors to its
 * byline; selecting an author shows that profile's interests; with nothing
 * selected the right column aggregates interests across the visible authors,
 * most frequent first. Clicking a selected row clears the selection.
 */
function GroundingBrowser({ grounding }: { grounding: GroundingView }) {
  const { papers, scholars } = grounding;
  const [paperSel, setPaperSel] = useState<number | null>(null);
  const [scholarSel, setScholarSel] = useState<string | null>(null);

  const byName = new Map<string, ScholarView>();
  for (const scholar of scholars) {
    const key = normalizeName(scholar.name);
    if (!byName.has(key)) byName.set(key, scholar);
  }

  const paper = paperSel !== null ? papers[paperSel] : undefined;
  const visibleAuthors: readonly { name: string; scholar?: ScholarView }[] =
    paper?.authors?.length
      ? paper.authors.map((name) => {
          const scholar = byName.get(normalizeName(name));
          return scholar ? { name, scholar } : { name };
        })
      : scholars.map((scholar) => ({ name: scholar.name, scholar }));

  const selectedScholar =
    scholarSel !== null ? byName.get(scholarSel) : undefined;

  // Aggregate interests across the visible authors; stable sort keeps
  // first-seen order among equal counts.
  const aggregated = new Map<string, number>();
  for (const { scholar } of visibleAuthors) {
    for (const interest of scholar?.interests ?? []) {
      aggregated.set(interest, (aggregated.get(interest) ?? 0) + 1);
    }
  }
  const interests: readonly { label: string; count: number }[] = selectedScholar
    ? selectedScholar.interests.map((label) => ({ label, count: 1 }))
    : [...aggregated.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);

  const uniqueInterests = new Set(
    scholars.flatMap((scholar) => scholar.interests),
  ).size;

  return (
    <div>
      <p className="counts">
        {papers.length} paper{papers.length === 1 ? "" : "s"} · {scholars.length}{" "}
        author{scholars.length === 1 ? "" : "s"} · {uniqueInterests} research{" "}
        interest{uniqueInterests === 1 ? "" : "s"}
      </p>
      <div className="tree-browser grounding-browser">
        <div className="tree-col">
          <p className="tree-col-title">Papers</p>
          <div className="tree-rows tree-scroll">
            {papers.map((item, index) => (
              <div
                key={`${item.title}-${index}`}
                className={`list-row${index === paperSel ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="list-row-main"
                  onClick={() => {
                    setPaperSel(index === paperSel ? null : index);
                    setScholarSel(null);
                  }}
                >
                  <span className="list-row-title">{item.title}</span>
                  <span className="list-row-meta">
                    {[
                      item.year !== undefined ? String(item.year) : undefined,
                      item.venue,
                      item.authors?.length
                        ? `${item.authors.length} author${item.authors.length === 1 ? "" : "s"}`
                        : undefined,
                    ]
                      .filter((part): part is string => part !== undefined)
                      .join(" · ") || "—"}
                  </span>
                  {index === paperSel && item.relation && (
                    <span className="list-row-note">{item.relation}</span>
                  )}
                </button>
                {item.url && (
                  <a
                    className="list-row-link"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`open "${item.title}"`}
                  >
                    ↗
                  </a>
                )}
              </div>
            ))}
            {papers.length === 0 && <p className="dim small">no papers</p>}
          </div>
        </div>
        <div className="tree-col">
          <p className="tree-col-title">
            Authors{paper ? " — selected paper" : ""}
          </p>
          <div className="tree-rows tree-scroll">
            {visibleAuthors.map(({ name, scholar }, index) => {
              if (!scholar) {
                return (
                  <div key={`${name}-${index}`} className="list-row">
                    <span className="list-row-main">
                      <span className="list-row-title">{name}</span>
                      <span className="list-row-meta">no record</span>
                    </span>
                  </div>
                );
              }
              const key = normalizeName(scholar.name);
              const isSelected = scholarSel === key;
              return (
                <div
                  key={`${name}-${index}`}
                  className={`list-row${isSelected ? " selected" : ""}`}
                >
                  <button
                    type="button"
                    className="list-row-main"
                    onClick={() => setScholarSel(isSelected ? null : key)}
                  >
                    <span className="list-row-title">{scholar.name}</span>
                    <span className="list-row-meta">{profileMeta(scholar)}</span>
                  </button>
                  {scholar.url.length > 0 && (
                    <a
                      className="list-row-link"
                      href={scholar.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`open profile of ${scholar.name}`}
                    >
                      ↗
                    </a>
                  )}
                </div>
              );
            })}
            {visibleAuthors.length === 0 && (
              <p className="dim small">no authors</p>
            )}
          </div>
        </div>
        <div className="tree-col">
          <p className="tree-col-title">
            Research interests{selectedScholar ? ` — ${selectedScholar.name}` : ""}
          </p>
          <div className="tree-scroll">
            {interests.length > 0 ? (
              <div className="tag-row">
                {interests.map(({ label, count }) => (
                  <span key={label} className="tag">
                    {label}
                    {count > 1 && <span className="tag-count">×{count}</span>}
                  </span>
                ))}
              </div>
            ) : (
              <p className="dim small">
                {selectedScholar
                  ? "no interests on this profile"
                  : "no research interests"}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TreeBrowser({
  experts,
  counts,
}: {
  experts: ExpertsTreeView;
  counts: { departments: number; umbrellas: number; subfields: number };
}) {
  const departments = experts.departments; // relevance order, exactly as produced
  const [deptSel, setDeptSel] = useState<string | null>(null);
  const [umbSel, setUmbSel] = useState<string | null>(null);

  const department =
    (deptSel !== null
      ? departments.find((candidate) => candidate.name === deptSel)
      : undefined) ?? departments[0];
  const umbrellas = department?.umbrellas ?? [];
  const umbrella =
    (umbSel !== null
      ? umbrellas.find((candidate) => candidate.name === umbSel)
      : undefined) ?? umbrellas[0];
  const subfields = umbrella?.subfields ?? [];

  return (
    <div>
      <p className="counts">
        {counts.departments} departments · {counts.umbrellas} umbrella terms · {counts.subfields}{" "}
        subfields
      </p>
      <div className="tree-browser">
        <div className="tree-col">
          <p className="tree-col-title">Departments</p>
          <div className="tree-rows">
            {departments.map((departmentItem) => (
              <button
                key={departmentItem.name}
                type="button"
                className={`tree-row${departmentItem.name === department?.name ? " selected" : ""}`}
                onClick={() => {
                  setDeptSel(departmentItem.name);
                  setUmbSel(null);
                }}
              >
                <span className="tree-row-name">{departmentItem.name}</span>
                <span className="tree-count">{departmentItem.umbrellas.length}</span>
              </button>
            ))}
            {departments.length === 0 && <p className="dim small">no departments</p>}
          </div>
        </div>
        <div className="tree-col">
          <p className="tree-col-title">Umbrella terms</p>
          <div className="tree-rows">
            {umbrellas.map((umbrellaItem) => (
              <button
                key={umbrellaItem.name}
                type="button"
                className={`tree-row${umbrellaItem.name === umbrella?.name ? " selected" : ""}`}
                onClick={() => setUmbSel(umbrellaItem.name)}
              >
                <span className="tree-row-name">{umbrellaItem.name}</span>
                <span className="tree-count">
                  {umbrellaItem.count !== undefined
                    ? `${umbrellaItem.count}×`
                    : umbrellaItem.subfields.length}
                </span>
              </button>
            ))}
            {umbrellas.length === 0 && <p className="dim small">no umbrella terms</p>}
          </div>
        </div>
        <div className="tree-col">
          <p className="tree-col-title">Subfields</p>
          {subfields.length > 0 ? (
            <div className="tag-row">
              {subfields.map((s) => (
                <span key={s.name} className="tag">
                  {s.count !== undefined ? `${s.name} · ${s.count}×` : s.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="dim small">no subfields</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function DecomposeBody({ stage }: { stage: DecomposeStage }) {
  const experts = stage.experts ?? { departments: [] };
  const counts = stage.counts ?? computeCounts(experts);
  if (!stage.grounding) return <TreeBrowser experts={experts} counts={counts} />;
  return (
    <div>
      <section className="subpanel">
        <p className="subpanel-title">Literature grounding</p>
        <GroundingBrowser grounding={stage.grounding} />
      </section>
      <section className="subpanel">
        <p className="subpanel-title">Expertise tree</p>
        <TreeBrowser experts={experts} counts={counts} />
      </section>
    </div>
  );
}
