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
- Vertically and horizontally centered: a chat box, max-width 640px. One multiline textarea
  ("What do you want to think through?"), autosizing to 6 lines, Enter submits, Shift+Enter
  newlines. A small send button inside the box, bottom-right. Nothing else — no logo, no title,
  no marketing copy.
- On submit: POST /api/jobs, clear the textarea immediately (the prompt stays free for the next
  idea), and a job card appears under the chat box.

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

A right-side drawer, 420px, `--surface`, hairline left border. Sections:

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
   - `Offline (deterministic, no key)`.
   Saving makes a small live request through the selected backend first; invalid credentials/model
   leave the previous settings and secrets untouched. Secrets are write-only — the browser receives
   only `apiKeyConfigured` / `setupTokenConfigured`, never their values.
3. **Panel confirmation** — radio: `Ask me on the dashboard` (default) / `Approve automatically`.
4. **Credit recovery** — auto-resume toggle (default on), safety-buffer seconds, OpenRouter parser
   model (`openrouter/free`), and optional write-only OpenRouter API key. Known reset messages are
   parsed locally; the free router is used only for unknown formats.

Save button persists via PUT /api/settings; drawer closes on success.

## View 2 — Job dashboard (`#/jobs/:id`)

Header row: back arrow, topic (h1, truncated), status dot + label, and on the right the same
theme/gear buttons. Below the header, two zones: the pipeline graph (minimap) and the stage panel.

### Pipeline graph

A horizontal SVG graph, full width, ~120px tall, eight nodes joined by 1px connectors:

Process → Decompose → Panel → Confirm → First pass → Review → Proposal → Done

- Node: rounded rect, 96×44, label under it. Fill `--surface`, border `--border`.
- Status ring: pending = dim border; active = accent border + soft accent pulse; suspended =
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

**1. Process input** — the classifier. Body: a row of facts — input-type chip (accent outline),
`cotSteps` badge ("6 reasoning steps"). Then title (semibold), the sharpened question as a
blockquote, context paragraph (clamped), assumptions as a bulleted list, attachments as small
file chips with their one-line note. Empty states: "no assumptions detected", attachments row
omitted when none.

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
  seated members render as the same seat cards with checkboxes (all checked). Buttons:
  **Approve panel** (primary accent) and **Continue with selected** (enabled when the user
  unchecks seats; unchecking all but one disables it — a panel needs ≥2 members). Both call
  POST /api/jobs/:id/gate; the card then shows "resuming…" until the stream updates.
- *Decided:* one quiet line — "Approved as seated" / "Shrunk to 4 members (removed: …)" /
  "Approved automatically (settings)". With timestamp.
- *Not reached:* collapsed.

**5. First pass** — parallel thinking. Body: a member grid (2 columns desktop, 1 mobile). Each
member card: header (umbrella + department dim), live status ("thinking…" with pulse /
"done" / "failed"), and when the idea lands, tabs: **Paper · Chain · Novelty · Papers**.
- Paper: Abstract/Introduction/Method/Discussion/Conclusion as labeled sections, clamped.
- Chain: numbered steps 1..N, each one paragraph; the numbers become the anchor the review stage
  refers back to.
- Novelty: single callout paragraph, accent left border.
- Papers: the literature table (title, year, venue, one-line relation; title links out when a URL
  exists). Tab hidden when the member returned no literature.

**6. Review** — the deep one. The stage's nature is a nested walk (member → chain step → rounds),
so the body is a *progress matrix* plus a *round inspector*:
- Matrix: one row per member (label = umbrella), N square cells per row (chain steps). Cell
  states: dim (pending), accent pulse (under review now), `--ok` (passed round 1), `--ok` with a
  small ×k corner count (passed after k redevelopments), `--warn` (force-passed at the cap).
  A caption under the matrix: "cell = one chain step · colors = how it passed".
- Cursor line above the matrix while active: "Reviewing member 2/5 · step 3/6 · round 2 of ≤4".
- Round inspector: clicking a cell opens the rounds for that step, newest first. Each round block:
  - the P−1 comment chips in a row: commentor umbrella + verdict chip (Pass `--ok` outline,
    Build `--warn`, Interrupt `--bad`); clicking a chip expands reason, suggestion (Build), and
    evidence (Interrupt) — script evidence in a code block with its result, math as a block,
    reference as citation + locator link + "shows" line.
  - the judge card: verdict chip, reason, per-commentor assessment badges ("verified" accent /
    "authority" dim), evidence when present.
  - when the round ended in redevelopment: a bar "Re-developed from step i — steps 1..i−1 frozen"
    and the count of replaced steps.
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

### Failure & cancellation

A failed stage shows the error string in a `--bad` bordered box inside its panel; downstream
stages stay pending. A cancelled job freezes every panel as-is with a "cancelled" banner under
the header. An orphaned job (files present, scheduler unknown) shows a dim banner: "state
reconstructed from workspace files".

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
