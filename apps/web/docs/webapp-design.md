# Brain webapp — design specification

The webapp is the user interface of the `brain` server. It has exactly two views plus a settings
drawer. It is deliberately minimal: generous whitespace, one accent color, subtle hairline borders,
no gradients, no shadows, no decorative icons. System font stack. Every color comes from a token so
light and dark themes are complete, not approximate.

## Design tokens

```
--bg          page background            light #fafafa   dark #121212
--surface     cards, drawers            light #ffffff   dark #1b1b1b
--border      hairlines                 light #e4e4e4   dark #2c2c2c
--border-1..3 nested panel strokes: each nesting level (stage > card > inner box > nested box)
              steps 10% away from its parent's stroke so the hierarchy reads at a glance —
              lighter per level in dark theme, darker per level in light theme.
--text        primary text              light #1a1a1a   dark #ececec
--text-dim    secondary text            light #6b6b6b   dark #9a9a9a
--accent      single accent             light #2f6fed   dark #6ea0ff
--ok          completed                 #2e9e6b
--warn        Build / suspended         #d99a2b
--bad         Interrupt / failed        #d5484d
```

Theme: `data-theme="light|dark"` on `<html>`, default follows `prefers-color-scheme`, toggle
persists to localStorage. Radius 8px. Spacing scale 4/8/12/16/24/32. Transitions 120ms opacity and
color only.

## View 1 — Landing

An empty page. Nothing else competes with the chat box.

- Top right corner, fixed: theme toggle (sun/moon glyph) and a gear icon. Both are 32px ghost
  buttons.
- Vertically and horizontally centered: a chat box, max-width 640px. One multiline textarea.
  The whole composer is exactly 264px at rest (1.5× the original 176px) and grows with input to
  528px (3× the original) before the textarea scrolls; its text region is 182–446px. A paste
  longer than the cap anchors the
  VIEW to the first line while the caret stays after the last word — the start of the prompt is
  always the thing on screen. Enter submits, Shift+Enter newlines. The footer strip (attach dial,
  model chip, brain + environment status icons, send button) sits snug under the last text line
  with a tiny 4px gap. Nothing else — no logo, no title, no marketing copy.
- On submit: POST /api/jobs, clear the textarea immediately (the prompt stays free for the next
  idea), and a job card appears under the chat box.

### Environment status icons (next to the brain icon)

Beside the Brain Registry brain glyph, up to four small check icons stream live from
`GET /api/readiness` + the `readiness` SSE event: **LLM** (spark — the configured provider
answers), **code** (terminal — the host scratch workspace runs scripts), **internet** (globe —
outbound HTTPS works), and **SLURM** (queue layers — a probe job submitted through the user's own
template ran to completion). Colors: green ok, red failed, amber pulse while checking, dim never
run. An icon whose check is not required under current settings is NOT rendered at all — no SLURM
icon with the local runner, no LLM/internet icons with the offline provider. Clicking an icon
opens a popover with the outcome, the technical detail (command, stderr), the fix advice — written
by the configured LLM (thinking mode; max effort on the Agent SDK) when one is connected,
otherwise a built-in hint — plus "Re-run check" and "Ask AI for help" actions.

### Provider onboarding overlay

When the server has no verified LLM credential for the selected provider, opening the webapp pops
a smooth, light overlay (blurred backdrop, one centered card). It asks two things:

- **Where do jobs run** — "This machine" (local processes) or "SLURM cluster" (`sbatch`),
  initialized from the current settings. The deployment default is SLURM, so a laptop user must be
  able to flip this here: otherwise the SLURM readiness icon sits red with no obvious way out. A
  note under the cards explains what changes (the readiness strip gains/loses the SLURM probe; the
  batch template stays editable in Settings). The choice is saved on every path out — Connect and
  offline mode alike.
- **Model provider** — choose Claude setup token or Anthropic API key, paste the secret, and a
  short note underneath explains where to get one (`claude setup-token` in a signed-in terminal;
  console.anthropic.com → API Keys). Saving verifies through the normal settings endpoint.

"Use offline mode" and a session-scoped "Later" are the ways out.

### Submission gating (waiting until all icons are green)

Submitting while any required check is not green does not start the pipeline: the prompt is HELD
and a waiting card appears under the composer — "Preparing the environment… your run starts
automatically when every check below is green" — listing each required check with its live state,
message, and advice for red ones, plus "Run checks again" and "Cancel". The held submission fires
automatically the moment the readiness report turns ready. The server enforces the same rule
(POST /api/jobs answers 409 with the readiness report while a required check is failed), so the
gate holds even for API callers.

### Job cards (under the chat box)

One rectangle per job, newest first, same 640px column. The list streams live from
`GET /api/stream`. Each card, 64px tall:

- Left: two lines — topic (truncated, primary text) and a status line
  ("processing input…", "review · member 2/5 · step 3/6 · round 2", "waiting for your panel
  confirmation", "completed", "failed", "cancelled") in `--text-dim`, colored dot before it
  matching status (accent pulse while running, `--warn` when suspended, `--ok`/`--bad` terminal).
- Right: an X button. Clicking asks "Are you sure you want to cancel this job?" (inline
  confirm/deny buttons replacing the X, not a browser alert). Confirm calls POST cancel.
- The whole card (except the X) is clickable and navigates to `#/jobs/<jobId>`.
- Completed/cancelled cards stay listed (history is loaded from the server on refresh).

## Settings drawer (gear icon)

A right-side drawer, 420px, `--surface`, hairline left border. It slides in, and out again on
Escape, on a backdrop click, or on the close button; sections fold with an animated height (a
grid row travelling 0fr→1fr, since a native `<details>` cannot animate) and every animation is
dropped under `prefers-reduced-motion`.

**Each section saves itself.** There is no drawer-wide Save button: a select or checkbox saves the
moment it changes, a typed value saves shortly after the last keystroke, and a template textarea
saves when focus leaves it (an intermediate keystroke would fail the tag check on every character).
Each section shows its own outcome next to its title — a spinning ring while the save is away, a
green check that fades once it lands, or the server's reason if it was refused. Anything still
waiting on its debounce is flushed when the drawer closes.

The exception is a value that costs a real request to the provider: **every credential keeps its
own Save button beside the input**, which spins while the connection is tested and settles into a
check. A secret is submitted ONLY by that button — editing the model next to a half-typed key must
never send the key — and the input clears once it is stored.

This is a correction, not a preference. One drawer-wide Save re-sent the whole document for any
edit, so the server re-verified the selected provider to persist it: changing the review-round
budget took seconds and then reported "Claude token verified", as though that had been the edit.

Sections:

1. **Execution** — Runner select: `slurm` (default) / `local` (footnote: "runs on this machine,
   for development"). SLURM template: monospace textarea (12 rows) editing the template verbatim.
   Inline note: "Put `{{BRAIN_COMMAND}}` where the orchestration command must run." Validation:
   PUT is rejected server-side when the tag is missing; show the error under the field.
2. **Model connection** — Provider select:
   - `Anthropic API (developer key)` (default): password input for the API key, required model,
     optional base URL.
   - `Claude Agent SDK (setup token)`: password input for the token printed by
     `claude setup-token`, optional model (omitted uses Claude Code's default), plus advanced
     controls for max turns per pipeline task (default 100, range 1–500), optional per-task USD
     budget, reasoning effort, adaptive/disabled thinking, and fallback model.
   - `Cursor SDK (API key)`: password input for a key from cursor.com/dashboard, optional model
     (omitted lets the server pick), and the SAME advanced agent-SDK controls as the Claude Agent
     SDK — the two backends share one settings shape, so switching SDKs never changes the knobs.
   - `Offline (deterministic, no key)`.
   Saving makes a small live request through the selected backend first; invalid credentials/model
   leave the previous settings and secrets untouched. Secrets are write-only — the browser receives
   only `apiKeyConfigured` / `setupTokenConfigured`, never their values.
3. **Panel confirmation** — radio: `Ask me on the dashboard` (default) / `Approve automatically`,
   plus **If I do not answer**: `Continue on my behalf after a short countdown` (default on). Both
   gates — the reading of the submission and the panel — count down about 30s and then proceed with
   what the pipeline proposed, so an unattended run never stalls. Switching it off makes every gate
   wait indefinitely, **applies immediately to runs already in progress** (including one that has
   passed the first gate and not yet reached the second), and stops any countdown already on
   screen. While it is off it also overrides `Approve automatically`, and the card says so rather
   than disabling the choice.
4. **Review rounds** — select: `Bundle default` (follows the published workflow) or 1–10. The
   budget one chain step may take during review: the first review plus up to N−1 revisions.
   Applies to every NEW run — the value is snapshotted into the job at submit, so resumes replay
   it and older runs keep the budget they started with; the pinned bundle's declared bounds stay
   authoritative at run start.
5. **Credit recovery** — auto-resume toggle (default on), safety-buffer seconds, OpenRouter parser
   model (`openrouter/free`), and optional write-only OpenRouter API key. Known reset messages are
   parsed locally; the free router is used only for unknown formats.

Each section persists via PUT /api/settings carrying ONLY its own fields; the server keeps every
section the request omits, so one panel's save can never disturb another's.

### Stopping a panel seat mid-run

The control lives in ONE place: the **review** stage's progress matrix, on the seat's own name.
Hovering (or focusing) `Seat N` opens the seat's popover — its state and expertise, and a
`Stop this seat` button that expands into a confirm. Dismissal cannot be undone, so it always asks,
and the question states the cost: the seat contributes and reviews nothing further for the rest of
the run, and work in flight on the other seats restarts from the last checkpoint (the server stops
the worker and resumes the run without that seat). A 409 — dismissing this one would leave fewer
than two seats — is shown inside the popover.

A dismissed seat is **struck through and dimmed, never removed**: everything it produced up to that
moment stays exactly as it was. In its matrix row the steps it finished keep their colors and
redevelopment counts, and every step it never finished — including the one it was stopped on — stops
pulsing and carries a dim `×`: a blinking cell on a seat that has left would claim work in flight
where there is none. The seat shows no live position, stops holding the first-pass and review stages
open, and leaves the review's seat counts and cursor line, which count the seats still taking part.

## View 2 — Job dashboard (`#/jobs/:id`)

Header row: back arrow, topic (h1, truncated), status dot + label, and on the right the same
theme/gear buttons. Below the header, two zones: the pipeline graph (minimap) and the stage panel.

### Pipeline graph

A horizontal SVG graph, full width, ~120px tall, nine nodes joined by 1px connectors:

Process → Decompose → Panel → Confirm → First pass → Review → Audit → Proposal → Done

- Node: rounded rect, 96×44, label under it. Fill `--surface`, border `--border`.
- Status ring: pending = dim border; active = accent border + an implicit dark-grey pulse
  (#565656 at low opacity, both themes — the blink hints at activity without a signal color);
  suspended =
  `--warn` border; completed = `--ok` check glyph top-right; failed = `--bad`.
- The Review node is wider (140px) and shows a live sub-line while active:
  "m 2/5 · s 3/6 · r 2" from the cursor.
- Clicking a node scrolls to / selects that stage's panel below. The active stage is selected by
  default and follows the run while the user hasn't clicked elsewhere.

### Stage panels — designed per node, not generically

Every panel shares only the frame: stage name, status, started/elapsed time, and a body that is
DESIGNED FOR THAT STAGE'S TASK AND ARTIFACTS. All artifact text is selectable; long texts clamp
to 4 lines with "more". Panels render skeleton lines while the stage is active and its artifact
has not landed yet, and render nothing (collapsed row) when pending.

While an agent is active, the frame also shows a bounded **Activity** feed (latest 20 of up to 200
stored events): agent start/completion, model turns, WebSearch/WebFetch/Read/Glob/Grep/Bash starts,
five-second tool heartbeats, API retries, context compaction, and artifact validation. These are
sanitized operational events only — assistant prose, chain-of-thought, prompts, credentials, tool
outputs, and command contents are never logged or sent to the browser.

**1. Process input** — the classifier. Body: a row of facts — the submission-type chip (accent
outline; the label is whatever the bundle's `catalog/input-types.json` defines — that file is the
single reference for the types the pipeline considers, shipped as `research idea · open problem ·
unverified claim · research proposal · completed work · empirical result · research area ·
established concept`) and the `cotSteps` badge ("6 chain steps"). Then title (semibold), the
sharpened question as a blockquote, context paragraph (clamped), assumptions as a bulleted list,
attachments as small file chips with their one-line note. Empty states: "no assumptions detected",
attachments row omitted when none. The catalog maps the type to an output SHAPE, which drives the
First pass panel's primary tab below.

**2. Decompose** — the expertise tree. Body: three columns (Departments / Umbrella terms /
Subfields). Departments render as rows; selecting one filters column two; selecting an umbrella
filters column three (subfields as plain tags). Default selection: first department. A summary
line above: "3 departments · 5 umbrella terms · 12 subfields". This is a *tree browser*, not a
graph — relevance order is preserved exactly as produced.

**3. Panel selection** — the deterministic seating. Body: seat cards in a wrap grid, one per
member, ordered: seat number ("Seat 1"), department (dim, small), umbrella (semibold), subfield
tags. A dim footnote explains the mechanism: "Selected round-robin from N umbrella leaves,
capped at P seats." If the confirm gate later shrank the panel, removed seats stay visible here
with a struck-through style and a "removed at confirmation" tag — the selection history is not
rewritten.

**4. Confirm panel** — the human gate. Three states:
- *Pending (job suspended):* an action card — "The panel is waiting for your confirmation." The
  seated members render as the same seat cards with checkboxes (all checked). ONE primary button
  whose action follows the checkboxes — the selection is the decision, so it can never be
  silently discarded: with every seat checked it reads **Approve panel** (action `approve`);
  with seats unchecked it reads **Continue with N of M seats** (action `shrink`, retained ids
  from the checked set); with fewer than two total seats it is disabled with a hint (a panel
  needs ≥2 members). It calls POST /api/jobs/:id/gate; the card then shows "resuming…" until the
  stream updates.
- *Auto-approve countdown:* an unattended gate never idles the run. The SERVER counts down 30
  seconds from first observing the suspension (restart-safe, works with the browser closed) and
  then approves the panel as seated. While pending, the card's top shows a thin `--warn`
  progress bar filling toward the deadline ("auto-approves in Ns — click anywhere to pause")
  with a small pause button. ANY click inside the card — a checkbox, the pause control, the
  builder — permanently holds the countdown (POST /api/jobs/:id/gate-hold); the bar is replaced
  by "auto-approve paused — take your time".
- *Custom seats:* next to the suggested seat cards sits one dashed ghost card — empty
  placeholders for **Department** and **Field**, plus a dashed rectangle with a + at its middle
  that adds subfield inputs (at least 1, at most 3). "Add seat" materializes it as an
  accent-bordered custom card (removable) and the primary button gains "+ N custom". The answer
  carries them as `addedMembers`; the runtime assigns ids (`member-user-N`), appends them to the
  panel (kept + added must stay within 2–12 seats), and they flow through first pass, review,
  audit, and synthesis like any selected seat.
- *Decided:* one quiet line — "Approved as seated" / "Shrunk to 4 members (removed: …)" /
  "Approved automatically (settings)", plus "· added N custom seats" when the user added any.
  With timestamp.
- *Not reached:* collapsed.

**5. First pass** — parallel thinking. Body: a member grid (2 columns desktop, 1 mobile). Each
member card: header (umbrella + department dim), live status ("thinking…" with pulse /
"done" / "failed"), and when the output lands, tabs: **[shape tab] · Chain · Novelty · Papers**.
The primary tab is DESIGNED PER OUTPUT SHAPE — the nine shapes are code; which type maps to
which shape is catalog data:

- `paper` → **Paper**: Abstract/Introduction/Method/Discussion/Conclusion as labeled sections,
  clamped.
- `resolution` → **Resolution**: status chip (`resolved`/`refuted` in `--ok` — a disproof is a
  decisive resolution too; `partial` in `--warn`; `still open` dim), then Problem, Approach, the
  numbered Derivation steps, Verification as an evidence block (script/math; "no self-check was
  possible" when absent), Remaining gaps, Significance, and a Known-results table (Result / Kind
  tag / Relation).
- `verification` → **Verdict**: verdict chip (`confirmed` `--ok`, `refuted` `--bad`,
  `partially correct` `--warn`, `indeterminate` dim) plus a confidence chip, the claim as a
  blockquote with its source in a dim line, the Evidence block (script code + result, math block,
  or citation + locator link + "shows"), Reasoning, and the confidence rationale.
- `feasibility` → **Assessment**: feasibility chip (`feasible as is` `--ok`,
  `feasible with changes` `--warn`, `not feasible` `--bad`), Design/Importance/Hypothesis
  logic/Replicability sections, a Methodology-soundness table (Aspect / `sound`·`concern`·`flaw`
  chip / Note), Required changes, Alternative designs.
- `critique` → **Review**: recommendation chip (`sound` `--ok`, `sound with revisions` `--warn`,
  `not sound` `--bad`), Artifact summary, Strengths list, itemized Issues (severity chip
  `minor` dim / `major` `--warn` / `critical` `--bad`, description, suggestion, evidence block
  when present), Missing considerations, and a Next-steps table sorted by priority.
- `interpretation` → **Interpretation**: confidence chip, Observation, ranked Candidate
  interpretations (plausibility chip + for/against evidence lines), the Most-likely reading as an
  accent callout with its confidence rationale, Threats to validity, Implications.
- `survey` → **Landscape**: one section per school of thought (name, characterization, its works
  as a mini literature table), a Comparison table when a decision was requested, Consensus &
  frontier, Open gaps, and the Recommendation as a callout when one was asked for.
- `explanation` → **Explanation**: Why it matters, the Core intuition as an accent callout, Formal
  treatment, Worked example, Common misconceptions (each with its correction in a dim line), and
  Connections as a tag row.
- `solution` → **Solution**: Problem framing, the Diagnosis as an ordered list (most likely cause
  first, rationale dim under each), an "Already tried" table (attempt / outcome) when prior
  attempts exist, Candidate solutions, the Recommendation as a callout, the Validation plan as a
  numbered list, and Residual risks.

Shared tabs on every card:
- Chain: numbered steps 1..N, each one paragraph; the numbers become the anchor the review stage
  refers back to. What a "step" is follows the shape (reasoning step, proof step,
  evidence-gathering step, …).
- Novelty: single callout paragraph, accent left border. Present only for the shapes positioned
  against a literature map (`paper`, `resolution`, `survey`); the tab is hidden otherwise.
- Papers: the literature table (title, year, venue, one-line relation; title links out when a URL
  exists). Tab hidden when the member returned no literature.

**6. Review** — the deep one. The stage renders as TWO detached panels with the page background
visible in the gap between them: the *progress grid* rides inside the stage frame (header,
activity feed, fold), and the *walk inspector* sits below in its own panel.
- Grid panel: one row per member (label = seat name), N square cells per row (chain steps), then
  the seat's FULL expertise reading left to right from biggest granularity to smallest —
  "department / umbrella · subfield · subfield" — dim and ellipsized. Cell states: dim
  (pending), accent pulse (under review now), `--ok` (passed round 1), `--ok` with a small ×k
  corner count (passed after k redevelopments), `--warn` (force-passed at the cap). A caption
  under the grid: "cell = one chain step · colors = how it passed". Clicking a cell opens that
  seat's walk in the inspector and scrolls to the step. Cursor line above the grid while
  active: "Reviewing member 2/5 · step 3/6 · round 2 of ≤4".
- Card elevation: the inspector reads as cards resting on a background — minimal, with a bit of
  shadow. The walk panel is the deepest (darkest) level (`--elev-0`); every card sits on the one
  beneath with a soft shadow (`--card-shadow`) and a slightly lighter surface (`--elev-1/2/3`),
  in BOTH themes — dark lightens toward the front, light steps from grey up to pure white — so
  the front-most card is always the lightest. The deepest level — the walk panel the seat card
  rests on — carries no stroke: it reads as ground, not as a card. No stacked-deck peeking
  anywhere.
- Walk inspector: everything belonging to ONE seat lives in one outer card (no rule under its
  header). The header packs the pager arrows tight around the title — "← Seat 1 / 3 →" — then
  the state chip ("under review" pulse / "done with thinking" `--ok`), and balances the seat's
  full expertise (department / umbrella · subfields) on the right. One seat visible at a time.
  Inside, one card per chain step stacks vertically ("Step i / N" colored by its outcome, plus
  the ×k redeveloped badge).
- Round deck: one sub-card per VERSION of the step, not per round. A round that rewrote nothing
  wrote no version, so it gets no card — its review rides the version it actually read, which is
  why a position that ends on a Pass has no trailing card repeating the previous text. Every
  round's review still appears exactly once. A step the walk has reached but recorded nothing for
  yet reports what its seat is doing ("round 1 in progress — commentors are working") instead of
  reading as untouched. Cards are NEWEST ON TOP (round k sits over
  round k−1), paged exactly like the seats: the same ghost prev/next chevrons hugging the
  "Round k / K" title in the card header (disabled dim at either end). The header also carries
  the verdict chip, a "redeveloped" badge, and a copy icon that copies the round as a
  plain-text bug report (seat, step, round, verdict, issues, texts). The deck's BASE is the
  "Original thought" card — the step's first-pass text, the one card rendered at full weight in
  its entirety — so every later card's full-weight words are exactly what that version changed,
  and Round 1 is compared against the original like any other version (a round that rewrote
  nothing renders fully dimmed with an "unchanged this round" note). The base card joins only
  decks that have at least one round or cross-rewrite; an untouched step keeps its pending card.
- Round text: the step text as it came OUT of that round (its number is an identity, not a
  verdict — that round's verdict rides with its comments, one card back), full height, never
  clamped or scrolled. Words carried from earlier rounds render dimmed; the round's own changes
  render at full weight (round 1 is all full-weight — nothing was reviewed before it). When the
  round's
  revision also rewrote OTHER steps, the card carries only a one-line note per rewritten step
  ("also rewrote step 5 this round — see step 5"); the rewritten text itself is shown on the
  affected step, never here.
- A cross-step rewrite is ITS OWN card in the AFFECTED step's round deck, placed in true
  chronological position — before the step's own rounds when an earlier walk position caused
  it, after them when a later one did. The card is labeled "changed by step N" (hover names the
  exact origin round and the direction) and shows the step's updated text with the changed
  words colored — color only, no background tint, no underline — and carried words dimmed.
  The DIRECTION is the color: `--prospective` dark blue when an EARLIER position's review
  rewrote this later step (prospective), `--bad` red when a LATER position reached back
  (retroactive); the origin card's one-line notes use the same two colors. A step's own-round
  changes keep the normal full-weight-over-dimmed treatment. The step's own "Round k / K"
  numbering never shifts around these cards, and older cards keep the step's history
  untouched. The "redeveloped" badge belongs to the review shown on the card — it says THIS
  version was sent back — not to the round that wrote the text, so it travels with the comments.
- Comments panel: under the text the comments were actually made against, collapsed by default.
  A round is handed a text, gathers comments on it, and only then redevelops, so round k's
  comments describe the version the PREVIOUS card shows: every card carries the review of the
  version it displays, which puts round 1's comments under "Original thought" and leaves the
  newest version unreviewed until a later round reads it. The summary row names the round the
  review came from, because the card it sits on is numbered for the round that WROTE the text,
  not the one that judged it. The reviewer names ride ON the
  summary row itself, right after the "Comments & judgement · round k" label — Judge first,
  then each commentor — each name colored by its verdict (`--ok` Pass, `--warn` Build,
  `--bad` Interrupt, dim pending), so the row is a verdict summary even while folded. Clicking a
  name opens the
  panel on that reviewer (Judge is the default): the judge's reason, confirmed issues (step /
  verified-vs-authority / must-address badges, evidence), and per-commentor assessment badges;
  a commentor's reason, suggestion (Build), and evidence (Interrupt). A copy icon copies the
  selected view.
- Final output: the seat card ends in a fold carrying the member's output as the review leaves
  it — the first pass with every redevelopment applied, rendered with the same tabs as a
  first-pass card. Chip-marked "final version" (`--ok`) once every step of the member's walk has
  passed or force-passed, "in progress" until then, with a meta line "revised ×k during review" /
  "unchanged from the first pass". Once the walk is complete, the fold's top-right corner gains a
  ghost download button (download glyph): it saves the seat's whole output — the shape body's
  sections, requested outputs, novelty, chain of thought, and collected literature — as
  `seat_<N>.tex`, a self-contained LaTeX file (client-side generated, titled by the submission
  topic, authored as the seat) that embeds the repo's shared `latex_style.sty` via
  `filecontents*`, so the one downloaded file compiles anywhere in the app's style. The first-pass
  panel keeps showing the original version — the
  history is never rewritten. The same final versions are saved as readable copies under the
  session's `final/` directory (one JSON per member, plus the proposal), which is what the CLI
  names when a run finishes.
- Empty state (stage pending): collapsed row like every other stage.

**7. Proposal** — the synthesis. Body, in order: title (h2), framing paragraph, then a three-column
band — Consensus / Tensions / Novel directions — each a titled list (tensions titled in `--warn`
tone, novel directions in accent tone). Then **Action items** as a compact table sorted by
priority (# / action / rationale). Then applications as a tag row. Top-right of the panel: two
ghost buttons — "Copy JSON" and "Download .md" (client-side markdown rendering of the same
content).

**8. Done** — the receipt. Body: total duration, a per-stage duration bar list (label + thin
horizontal bar scaled to the longest stage + ms), and agent-task count. One line, dim: session
directory path.

The **capability & tool usage receipt** appears on the Done page only — below the stage frame rather
than inside it, because a run that failed, was cancelled, or credit-blocked never reaches a completed
Done stage and a pending frame renders no body, which would hide the receipt from exactly the runs
whose agents were most likely missing something. It (`GET /api/jobs/:id/tool-usage`) reports which
tools each role actually called, calls by stage, and the capability-resolution matrix (per declared operation: how
many tasks resolved it provider-native, host-tool, or unavailable), and it leads with two warnings
when they apply:

- **Ran without** — the operations that resolved unavailable, and how many tasks were told so. Those
  agents were instructed not to work around the gap, so their conclusions have to be read in that
  light.
- **Refused calls** — calls that were made and failed, whether denied by a permission hook or
  errored, counted apart from the totals beneath them.

Both are warnings rather than dim asides, and the receipt is not gated on a run finishing. Gated on
the Done stage's summary it appeared only after a clean finish, so a run that failed, was cancelled,
or credit-blocked never showed the one record of what its agents could actually do — which is how a
deployment whose agents could not open any submitted file went unnoticed until a judge said so in
prose.

### Failure & cancellation

A failed stage shows the error string in a `--bad` bordered box inside its panel; downstream
stages stay pending. A failed job additionally shows a "Failed" banner with a **Retry from
checkpoint** button (`POST /api/jobs/:id/retry`): task failures are never journaled, so the
retry resubmits the same deterministic resume command, replays the completed work, and re-runs
only the task that failed. Jobs that failed before their first checkpoint are refused with a
hint to submit a new job. A cancelled job freezes every panel as-is with a "cancelled" banner
under the header. An interrupted job (files present, process gone — SLURM timeout, node failure,
power cut) shows an "Interrupted" banner with a **Resume from checkpoint** button; its
landing-page card shows a resume glyph next to the X, and its status line reads "interrupted ·
resumable from checkpoint". The scheduler also resubmits interrupted jobs automatically
(Settings → Interrupted jobs, default on) and pauses after three resubmissions without
checkpoint progress.

A credit-blocked job keeps its interrupted stage selected with a warning badge and live countdown:
"Credit blocked · resumes in 1h 12m at 17:30". The dashboard offers `Cancel auto-resume`, followed
by inline confirmation. Cancelling marks the job terminal, so the restart-safe scheduler never
submits it.

## Live updates

The dashboard subscribes to `GET /api/jobs/:id/stream` (SSE, full `JobDetail` snapshots,
throttled server-side). Reconnect with backoff; while disconnected show a thin `--warn` line
"reconnecting…" under the header. The landing page subscribes to `/api/stream` the same way.

## Non-goals (v1)

No auth, no multi-user, no editing artifacts from the UI, no mobile-specific layouts beyond the
grid collapsing to one column.
