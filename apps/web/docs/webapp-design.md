# Brain webapp — design specification

The webapp is the real HTTP/SSE client of the `brain` server. Its persistent canvas shell has a
compact navigation rail, a floating research library, a central research composer, and nested quick
controls. A centered settings window remains available for configuration that needs a larger form.
History and trash open beside the current workspace, without replacing it. On phones the rail moves
to the bottom. Existing research stage deep links remain stable.
The visual direction uses pale animated light, rounded surfaces, generous whitespace, and indigo
accents. Light and dark appearances support a plain or custom background.

**Nothing is set in capitals, anywhere.** Labels, section heads, column titles, badges and detail
labels are sentence case: a small-caps run reads as shouting at every size this app uses, and the
tracking that has to accompany it makes lowercase text look loose when the transform is dropped.
Hierarchy comes from size, weight and colour only. (Nine rules carried `text-transform: uppercase`
and were removed together; a DOM sweep asserts nothing renders transformed.)

## Design tokens and extension points

`src/canvas.css` supplies shell tokens and aliases for existing research panels; feature CSS stays
scoped to its owning surface. Colors use `--bg`, `--surface`, `--text`, `--text-dim`, and `--accent`.
Interface surfaces and controls are borderless: use `--ui-field-bg`, `--ui-control-fill`, spacing,
and `--ui-float-shadow` for separation. New features use these tokens rather than literal colors
or global button rules. Icons and diagram connections keep their meaningful linework.
`src/shell/navigation.ts` declares library rail controls; `src/shell/routes.ts` separates the main
view from its optional library panel. Settings navigation and section membership
are declared in `src/components/settings/catalog.ts`. `src/components/quick-controls/WorkspaceControls.tsx`
binds those categories to quick actions; `QuickControls.tsx` handles menu presentation independently
of settings transport. On/off controls share the pill-shaped `SettingsToggle`/`ToggleMark` components
in `src/components/settings/`; do not introduce square checkboxes for settings.

### Sizing and density

`src/sizing.css` is the shared sizing source for the shell, research library, composer, menus,
and settings. Feature styles consume semantic custom properties, including portaled controls.
Do not reduce the document's zoom or transform-scale a feature to change its density.

| Role | Fine pointer | Coarse pointer |
| --- | --- | --- |
| Field and action control | 32px | 44px |
| Compact icon control | 28px | 44px |
| Inline clear control | 24px | 44px |
| Category navigation | 36px | 44px |
| Rail target | 40px | 44px |
| Utility / navigation glyph | 16px / 18px | 16px / 18px |
| Text entry | 13–14px | 16px |
| Empty composer | 56px minimum | Content-driven with 44px controls |

These are CSS pixels; screenshot pixels vary with device scale and zoom. The spacing scale uses
4/8/12/16/20/24/32px steps. Border compensation and optical centering may use intermediate values
when needed to meet a control's outer height. Radii are 6/8/12/16px, with 20px reserved for the
composer and larger surfaces. Icons have explicit width/height and never inherit text size.
Visible glyph size is independent of the clickable target.

Text fields retain their height when a clear button appears. Focus uses a distinct solid fill
(`--ui-focus-fill` with `--ui-focus-text`) rather than a border, outline, or shadow ring. The composer
and search field highlight their containing surface while the text input remains transparent;
their inner buttons have their own focus fills. High-contrast mode uses system highlight colors.
The composer responds to viewport width and content. Opening the floating library leaves its
column width unchanged, so it never squeezes the text entry between tool controls.
Multiline input, longer labels, and touch interaction can increase height rather than clip content.
Existing technical displays keep their own measured row-height/virtualization contracts.

The target decisions use [WCAG 2.2 minimum target guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
and the [44px enhanced target guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced)
as references. This is a product sizing system, not a claim of whole-application WCAG conformance.

Appearance is a versioned, validated local preference: system/light/dark theme, background, motion,
and quality. The shared external store resolves system theme changes and migrates `brain-theme`.
Background renderers are lazy modules with explicit mount/update/dispose lifecycles. See
[backgrounds.md](../../../docs/backgrounds.md) for adding a custom animation, its budgets, and failure isolation.

## Home and research library

The home page centers a rounded composer with attachment, model, capability, and submit controls.
It expands for multiline input and attachments; Enter submits and Shift+Enter adds a line.
Readiness remains visible beneath it. Submission uses the real server, then opens the returned run.
An unfinished composer remains mounted when opening a run, while its background polls and floating
menus stop. Its per-tab session draft survives reloads when browser storage is available; validated
attachments are rechecked before submission.

Separate History and Trash rail icons open a floating library panel over the current composer or run.
The panel starts with the search field, without a visible heading, duplicate section buttons, or close
button; its accessible name remains available to screen readers. Search/counts
stay pinned above an independently scrolling list. Each section retains its search and page while
switching or collapsing. Opening or switching library sections preserves the main view's DOM,
selections, draft, and position. Selecting a research item changes the main view and closes the panel.

The panel is 336px wide, bounded by the available viewport on narrow screens. Its width cannot be
resized and is not saved in browser storage. It remains non-modal at every viewport size, with no
backdrop or change to the workspace's layout. Clicking outside, pressing Escape, choosing New
research, or selecting a run dismisses it. Repeated rail clicks toggle the
current section, while choosing the other library section switches the content without closing it.
Nested action menus remain part of the panel for dismissal and focus handling. An outside click can
both dismiss the panel and activate a workspace control; focus stays with that newly selected control.
When focus remains inside the closing panel, it returns to the relevant rail trigger.

The mounted panel preserves its list state through a 180ms transform/opacity transition; reduced
motion disables that animation. Viewport changes adjust its bounds without replacing its content.
Transient workspace menus close on main-view/stage navigation or when the library opens or switches
sections. A panel-only closure leaves a workspace menu opened by the same click intact.

The rail and Ctrl/Cmd+K open History. URLs encode both independent surfaces, for example
`#/jobs/run-42/stage/review-members?panel=history`. Back/Forward restores both. Legacy `#/history`
and `#/trash` links still work and preserve the currently open main view when followed in the app.

Search matches titles, prompts, IDs, and statuses using a deferred query. Rendering is capped at
50 rows per page. Full run records load when opened in the main workspace. Pause, resume, retry,
redo, trace-download, and trash actions retain their server semantics; destructive actions require
inline confirmation. Trash is searchable and read-only. Loading failures expose retry controls.
A changing result count clamps the selected page safely.

`src/features/library/WorkspaceOverview.tsx` owns one shared overview SSE connection and initial
reads. Jobs, readiness, and connection state use independent subscriptions, so list updates do not
rerender the composer or dashboard. Collapsed library consumers stop subscribing. The list and
its action controls are lazy-loaded, with an error boundary separate from the main workspace.

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

### GPU discovery and approval

A GPU control sits immediately after the model connection icon. GPU setup is optional and does
not hold ordinary research submissions. After a verified model credential becomes available,
the server discovers the host and scheduler; mounting the browser control only reads its report.
The icon shows discovery progress, pending approval, probe activity, readiness, or a failure.
One shared poller reads the report every 1.5 seconds during discovery/probing and every 15 seconds
otherwise, stopping when no GPU surface is mounted.

The control opens a Base UI dialog with the discovered host architecture and Slurm catalog.
Partition, account, QOS and GPU type are selections drawn from discovery. Account changes restrict
QOS choices; reservation-only QOS requires a reservation. Resource counts, memory, time and nice
use bounded fields. A multiline environment setup field supports module or conda activation.
These edits remain a draft until the user saves them; the server then regenerates the exact probe
script. Saving a changed draft disables the previous GPU configuration pending another probe.

The reviewed script carries a revision and review token. Only the explicit **Approve and run
probe** action submits it; discovery, opening the dialog, and saving a draft submit no GPU job.
The probe is capped at two minutes and checks CUDA driver access and a GPU memory transfer without
installing packages. It does not verify an application's framework dependencies. Success enables
GPU execution for roles with the relevant capability. Queue status and logs remain visible;
cancellation failures require retrying cleanup before editing or submitting again.

Settings → Execution and the quick execution menu lead to this same dialog rather than directly
editing an executable template. Stale approval is rejected, unsaved edits survive a close attempt,
and the dialog returns focus to its trigger. API-mocked browser tests cover the approval boundary,
resource selections, cancellation, stale drafts, and narrow-screen review.

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

### Research rows

Rows show a two-line title, live status, and date. Selecting the title opens the research and
closes the floating library. The selected run is highlighted with `aria-current`.
A More menu groups actions according to run status. Stop and Move to trash use inline confirmation.
Completed and cancelled records stay available; trashed records can be read from the Trash section.
Download saves the server's trace zip using a native download link.

## Quick controls and settings

The Settings rail menu opens the seven categories as submenus, without opening the full settings
window. Toggles change on/off values in place and keep the menu open; exclusive choices show a
selected dot. Rows show pending or failed saves beside the affected control. Unavailable controls
explain their prerequisite, and unconfigured services offer setup instead of claiming to be enabled.

Desktop menus use Base UI nesting and collision handling. On narrow or coarse-pointer screens,
each tier replaces the contents of one floating menu, with a sticky Back control. Escape returns
one tier at a time; clicking outside dismisses the menu and lets the selected workspace control
receive focus. The main workspace and its draft remain in place. Menu dimensions and touch targets
come from `src/sizing.css`, with scrolling for long tiers and reduced-motion support.

The category describes its common scope once. Most server choices establish defaults for new
research; the approval countdown explicitly affects active runs immediately, and recovery controls
apply to existing interrupted or credit-blocked runs. Appearance is a browser preference. Composer
capability switches apply to that submission, while model-by-task choices save defaults for new runs.

Actions ending in an ellipsis open an editor. Models, task limits, paid-search limits, contact email,
recovery buffer, and version details use compact anchored editors loaded on demand.
These editors use Apply/Cancel for editable values. Closing a pending editor cancels its opening,
so a delayed module cannot reopen over later work. An editor boundary contains loading/rendering
failures in a dismissible popover with an explicit Settings fallback; an optional chunk failure
does not reload the app. Connection credentials, multiline execution
scripts, and recovery parser configuration open the relevant Settings form; All settings remains
an optional overview.

`settings-commands.ts` defines validated field operations. `settings-store.ts` shares confirmed
settings, pending changes, and per-control errors rather than maintaining separate state per menu.
Quick changes build their patch against fresh settings after earlier writes complete in the shared
API queue, preserving sibling fields and tool lists. Failed writes restore confirmed state and keep
an actionable error; closing a menu does not cancel a write already sent. Model-routing saves use
the same browser queue, and both server settings endpoints share server write ordering.

### Settings window

Base UI handles the menu and modal interaction: keyboard navigation, focus containment, dismissal,
and focus return. The desktop settings window is 1120×620 px, capped by viewport size. It has a
category rail, an independently scrolling form area, and a persistent footer. On narrow screens,
categories scroll horizontally and fields become a single column. Short landscape viewports retain
scrollable content and reachable close controls.

Categories are Models & connections, Research, Tools & sources, Execution, Recovery, App updates,
and Appearance. Only active sections mount; their editable values stay at dialog scope so switching
categories retains drafts. Closing waits for pending saves and shows a choice if values failed to
save or credentials remain unsaved. It never silently discards those drafts.

**Each section saves itself.** There is no drawer-wide Save button: a select or toggle saves the
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
3. **Panel confirmation** — `Ask me before approval` switch (default on): on stores manual
   confirmation; off stores automatic approval for new research. The same direct switch appears
   in the Research quick menu and full Settings, with no extra submenu. It remains changeable
   when the separate `Continue after countdown` switch (default on) is off. Both
   gates — the reading of the submission and the panel — count down about 30s and then proceed with
   what the pipeline proposed, so an unattended run never stalls. Switching it off makes every gate
   wait indefinitely, **applies immediately to runs already in progress** (including one that has
   passed the first gate and not yet reached the second), and stops any countdown already on
   screen. While it is off it also overrides automatic approval for new research; the control
   explains that automatic approval is paused. Changing the preference never switches the live
   countdown on implicitly. It cannot restore gates already skipped by an automatic worker.
4. **Review rounds** — select: `Bundle default` (follows the published workflow) or 1–10. The
   budget one chain step may take during review: the first review plus up to N−1 revisions.
   Applies to every NEW run — the value is snapshotted into the job at submit, so resumes replay
   it and older runs keep the budget they started with; the pinned bundle's declared bounds stay
   authoritative at run start.
5. **Credit recovery** — auto-resume toggle (default on), safety-buffer seconds, OpenRouter parser
   model (`openrouter/free`), and optional write-only OpenRouter API key. Known reset messages are
   parsed locally; the free router is used only for unknown formats.
6. **Web search** — choose app-managed or agent-native search. App-managed search uses one
   pipeline for routing by query kind, parallel dispatch under caps, failover, optional cross-run
   keyword caching, and a verbatim per-call log. Agent-native mode delegates search to the model
   backend; the host-provider/index/cache controls and app search log do not apply. The section
   holds the mode choice and, for app-managed search, the general
   provider select (`None (scholarly indexes only)` default / `SearXNG — launched by the app on
   this machine` / Tavily / Brave / `SearXNG (your own instance)`), the selected provider's
   write-only API key with its own Save button (verified with one real one-result search before
   it is stored, exactly like the LLM credentials; a pointed-at SearXNG takes a base URL instead
   of a key), the scholarly-indexes toggle (OpenAlex, Crossref, arXiv, Semantic Scholar —
   keyless, on by default, what paper/citation searches answer from), the cross-run cache toggle
   (off by default; hits still appear in the search log), and an optional polite-pool contact
   email. Selecting the app-launched SearXNG saves immediately and starts the instance in the
   background (the server finds Docker/Podman/Apptainer, downloads the search image on first
   start — a few minutes — and supervises it; the Agent capabilities readiness check turns green
   once it is up, and no query ever passes a third-party search API). The run's whole search
   record is served per job: `GET /api/jobs/:id/searches` (table rows carrying every named
   failure — a failed-over provider, a CAPTCHA-blocked engine — plus a per-run `failureSummary`
   counting each cause), `searches.csv`, and `searches.jsonl` (raw, every character of every
   request and answer).

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

- Node: borderless rounded rect, 96×44, label under it. Fill `--surface`.
- Status: pending = muted fill; active = accent-tinted fill + an implicit dark-grey pulse
  (#565656 at low opacity, both themes — the blink hints at activity without a signal color);
  suspended =
  `--warn`-tinted fill; completed = `--ok` check glyph top-right; failed = `--bad`.
- The Review node is wider (140px) and shows a live sub-line while active:
  "m 2/5 · s 3/6 · r 2" from the cursor.
- Clicking a node scrolls to / selects that stage's panel below. The active stage is selected by
  default and follows the run while the user hasn't clicked elsewhere.

### Stage panels — designed per node, not generically

Every panel shares only the frame: stage name, status, started/elapsed time, and a body that is
DESIGNED FOR THAT STAGE'S TASK AND ARTIFACTS. All artifact text is selectable; long texts clamp
to 4 lines with "more". Panels render skeleton lines while the stage is active and its artifact
has not landed yet, and render nothing (collapsed row) when pending.

One stage shows at a time, and the two steppers under the panel — "← First pass" and
"Integration audit →" flanking the page count — are plain text: no border, no fill, dim until
hovered, when the name underlines. They sit outside every panel, on the page background, where a
bordered button read as a control belonging to the panel above it rather than as a way out of it.

**Live text never gets a place of its own — it occupies the place of the output it is producing, and
is replaced by that output the moment it lands.** This is the rule, and it decides every position:
- a first-pass seat's words fill the card its idea will fill;
- a REDEVELOPER is writing the step's next version, so its words are the next CARD OF THE DECK,
  titled with the round it will become and marked "being written now" — the deck opens on it, so a
  reader watching a run is watching the version being written;
- a COMMENTER or the JUDGE is writing a comment or a judgement, so their words sit in the comments
  panel under their own name, beside the reviewers whose comments have already landed, each with a
  live dot. A landed comment replaces its author's thread individually, because a round's comments
  land one at a time.
A box beside the card would put the same work on screen twice and leave the reader to match the
preview to the thing it becomes.

The comments panel does not wait for the first comment to land. A round's record is born with its
first landed result, and a comment that verifies its claims takes minutes — so through a position's
whole opening phase the step card holds the panel with only live threads in it (above it, the step's
standing text and a one-line note of what the round is doing). And while a version's review is still
being written — nothing decided, reviewers mid-sentence — the panel sits OPEN by itself and opens on
whoever is writing; once the round is decided it folds back to the collapsed default. The reader's
own toggle always wins over either default.

**A task that is working shows what it is saying, not the word "thinking".** While a first-pass seat
develops its idea, or a commenter/judge/redeveloper works on a step, the card carries a LIVE THREAD:
the words the model is producing, appended as they arrive, readable as prose and scrollable inside a
capped box (168px — the card never grows). It follows the newest words until the reader scrolls back,
and then stays where they put it.

The text is **revealed at a steady pace, not appended in the chunks it arrives in**: a frame delivers
about a second of writing, and landing it whole reads as jumps — several lines, then nothing. A
shown-length walks toward the real length every animation frame, spreading each frame's backlog over
~700ms, so what a reader sees is writing. Two cases stay instant: the first text a card ever shows (a
reader opening the page mid-task should not watch a minute of backlog type itself out) and a repair
frame shorter than what is displayed. A backlog past ~1200 characters — a tab that was in a background
window, where animation frames stop — is skipped to within the bound rather than typed out after the
model has moved on.

It is **not** the chain of thought and is styled so it cannot be mistaken for one — a muted surface,
dim monospace, sentence-case labels (nothing shouted), and a header that says "live, replaced by the
result". The moment the task's real
output exists the thread is DELETED and the output takes its place: the first-pass card switches to
its idea tabs, the review card to its version deck. Nothing about it is stored, nothing reads it back,
and no view is derived from it.

It costs the browser no requests at all: the worker appends fragments to one file per run, the server
tails it and holds only live threads, and each SSE frame carries the characters written since **that
connection's** last frame. A reader who opens the page mid-task gets the thread whole — the part of
the conversation they walked in on — and deltas after that.

**A quiet model is not a dead one.** A model composing its structured output emits nothing a reader
is shown for minutes, and a long verification command is silent for as long as it runs — while a
worker killed mid-task also goes silent, and ITS threads must disappear rather than show a dead agent
talking. The worker settles the ambiguity: while a task runs it re-announces the task's thread on a
heartbeat (bare keepalive records, several per staleness window), so a quiet thread holds its last
words until the real output replaces them, and only a worker that stopped writing altogether has its
threads expire.

**A thread's identity is stamped against the roster the run executes** — the seats kept at the
confirmation gate plus the custom seats added there, in fan-out order — never against the proposed
panel, which stops being the roster the moment the gate shrinks or adds. Stamped against the
proposal, an added seat's words landed under a seat that was never seated and its first-pass card
never showed its member thinking.

Every Activity row is annotated with fixed columns between the timestamp and the message, because a
review's feed is otherwise a wall of messages with no way to tell whose work is whose: **what** the
agent is (`Commenter`, `Judge`, `Thinker`, `Redeveloper`, `Bridge` — the row's category), **who** is
doing it (`Seat 2`, mono, full weight — the row's subject), and **where** it is happening
(`Seat 4 → step 5 > round 3`). The columns are sized against the widest thing each can say, measured
rather than guessed, and truncate with a hover rather than pushing the message around. The **who**
and **where** columns exist only in feeds where some row actually names a seat (first pass, review):
a stage whose rows never do — process, decompose — would render two wide columns of dashes, a gap
posing as alignment, so the feed decides once from its own rows and drops them. Within a seated
feed, a row missing a value (a run-level event) still shows a dim dash, since a blank next to filled
neighbours reads as a rendering fault. Below 900px the role and place drop, below 700px the actor
too — the message is worth more than any of them. The list scrolls on both axes so a long message
is panned to rather than wrapped, but only the vertical bar is drawn: the horizontal bar under
every feed read as permanent chrome, and the pan still works without it.

The **who** and the **where** are different questions, and for a commenter they have different
answers: the actor is the seat writing, the place is the seat being read. A round's commentors are
the panel minus the seat under review, in seat order, so the index in an execution path only becomes
a seat once it is projected back over the roster — the server does that, and sends no paths.

**An operation is ONE row, not two.** A tool call and an agent task are spans — they start, they
end — and the old feed logged each end as its own line, so half the feed was "X finished" echoes of
lines a few rows up. The server now folds the finish into the start's row: the line appears when the
work starts, and when it ends the same line gains its **status** ("finished" green, "failed" red,
empty while it still runs), its elapsed time, and — for an agent task — its token spend. The status
lives in its own fixed column so the eye can scan outcomes down the feed, and the row's dot takes
the outcome's colour. The event log itself stays append-only (starts and finishes are separate
journal lines, which is what makes this work retroactively for every old run); the fold happens
where the rows are built, and the row is addressed by the start's id, so a client that already
rendered the open row simply sees it update in place.

**The feed has no cap — it has a window.** The server keeps every stage's whole history
(`activityTotal` counts it) and embeds only the newest ~200 rows in a detail, plus a handful of
"late edits": older rows whose span just closed, riding along so an already-rendered line still
gains its outcome. `activityFloor` names the row id from which the embedded window is gap-free —
the anchor the client pages against. Scrolling toward the top fetches the previous page
(`GET /api/jobs/:jobId/stages/:stageId/activity?before=<id>`) and joins it seamlessly below the
floor, so the reader can walk from the newest row to the very first. The list is virtualized: only
the rows in view (plus a small overscan) exist in the DOM, with two spacers standing in for the
rest — a feed of any length costs the browser a couple dozen nodes, which is what makes unbounded
history affordable. Every row is exactly 28px tall by stylesheet contract; the spacer arithmetic
depends on it.

**The whole log is one click away.** The download arrow in the feed's header links to
`GET /api/jobs/:jobId/stages/:stageId/activity.csv` — every merged row of that stage at that
moment, with the same columns the feed shows (time, status, role, actor, where, message, tool,
elapsed, spend, capability, call detail). An anchor with `download`, not a handler: the browser
saves the file the server names, and none of it passes through the page's state.

The Activity feed scrolls in BOTH directions: rows never wrap, so a long line — a command with its
flags, a file path, a whole search query — is read by scrolling sideways rather than folded into two
lines that break the column alignment. The column gutters are tight (4px) because five columns of
small text read as a table, not as prose.

While an agent is active, the frame also shows the **Activity** feed's live tail: agent spans,
model turns, WebSearch/WebFetch/Read/Glob/Grep/Bash calls, five-second tool heartbeats, API
retries, context compaction, and artifact validation. These are sanitized operational events only —
assistant prose, chain-of-thought, prompts, credentials, tool outputs, and command contents are
never logged or sent to the browser.

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
  with a small pause button. ANY click inside the card — a seat toggle, the pause control, the
  builder — permanently holds the countdown (POST /api/jobs/:id/gate-hold); the bar is replaced
  by "auto-approve paused — take your time".
- *Custom seats:* next to the suggested seat cards sits one softly filled card — empty
  placeholders for **Department** and **Field**, plus a filled control with a + at its middle
  that adds subfield inputs (at least 1, at most 3). "Add seat" materializes it as an
  accent-tinted custom card (removable) and the primary button gains "+ N custom". The answer
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
- Novelty: single callout paragraph on an accent-tinted surface. Present only for the shapes positioned
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
- The pipeline spine carries air beneath it (22px): the stages row and the first panel were nearly
  touching, which read as one block — the pipeline is a thing you navigate WITH, not the panel's
  header. Scoped to the dashboard's spine, so the landing card's embedded graph keeps its own
  spacing.
- **A run can be paused, resumed and stopped — from the job card and from the dashboard header.**
  The three are not one control: PAUSE keeps the run (its worker ends, its checkpoint stands, and
  nothing automatic touches it until the submitter says so), RESUME continues from that checkpoint,
  and STOP ends it for good. Only stop asks first, because only stop cannot be undone; pause costs
  what any interruption costs — tasks in flight are re-executed on the resume, everything journalled
  replays free. A paused run can still be stopped; a stopped one can never be resumed.
  Three things make that legible rather than merely present: stop wears a filled SQUARE (it wore an
  ✕, which reads as "close this", so the control was there and nobody saw it); a control waiting on
  the server puts a spinner in its icon's place, because the round trip plus a scheduler call is
  seconds and a control that does not move for seconds reads as a control that did not work; and
  every icon control carrying a tooltip draws one — the rule used to name the resume button alone,
  so pause and stop were labelled in the markup and silent on screen. The labels are right-anchored
  above the control (centred, a nowrap label at a card's right edge runs off the window), and the
  job card no longer clips its own overflow, which had been cutting them in half.
- **Nothing may claim to be moving while the run is not — and one place decides it.**
  A pulsing dot, a blinking review cell, a shimmering skeleton, a counting clock, a streamed
  thought: each is the same claim, that work is in flight. Pausing a run makes every one of them
  false at once, and NOTHING else in the snapshot says so — a paused step still reads "under
  review" and its stage still reads "active", which is correct, because that is exactly where the
  run resumes. So liveness cannot be read off a step, a stage or a seat. It is the run's, and it is
  decided in `jobIsExecuting` (protocol, so the server and the page cannot drift: the server stops
  streaming live text on the same answer the page stops animating on). It reaches the screen as one
  attribute on the element that scopes a run — `<RunScope>`, which is what `.dash` and each
  `.job-card` are — and the stylesheet hangs every in-flight animation off `[data-run-live="false"]`.
  A new blinking thing inherits the behaviour instead of having to remember it, and two tests hold
  the line: every endless animation in the stylesheet must be listed in that rule or classified as
  not-a-run's (a spinner the user just pressed keeps spinning while the run stands still), and each
  run root must be a `RunScope` rather than a bare element. What CSS cannot decide asks
  `useRunLive()`: the stage clock stops where it stopped, the "no new events for Ns" banner goes
  away (a stopped run is quiet by design), "round N in progress" becomes "round N — unfinished"
  (never "stopped", which is a different button and a different fate), the landing card's five-second
  poll stops, and the streamed threads are dropped — their place belongs to the output that will
  replace them on the resume. Countdowns ask a narrower question, `useRunAttended()`: a suspended
  run runs no agent and still has its gate auto-approved, while a paused one is passed over
  entirely, so its card must stop promising a deadline nothing will act on.
- Walk inspector: everything belonging to ONE seat lives in one outer card (no rule under its
  header). The header packs the pager arrows tight around the title — "← Seat 1 / 3 →" — then
  the state chip ("under review" pulse / "done with thinking" `--ok`), and balances the seat's
  full expertise (department / umbrella · subfields) on the right. One seat visible at a time.
  Inside, one card per chain step stacks vertically: "Step i / N" colored by its outcome, and
  beside it only what is still happening. A redevelopment count used to sit there as a
  "×k redeveloped" badge; it now rides the title's hover, since the step's own cards already
  show every version it went through.
- **Every version is an EDIT ROUND, whoever wrote it, numbered in the order they happened.** A
  step's versions do not come only from its own review — a redevelopment at any position may rewrite
  it — so a step whose deck already showed three prospective edits used to head itself "round 1 in
  progress", counting only the review loop's iterations. One rule now serves the deck, the step
  header and the activity feed's round column, so no two of them can disagree: an edit is a round.
  A cross-step edit is titled "Round 3: edited prospectively during the review of step 4" (only the
  adverb takes the direction's colour); the step's own rounds are titled "Round 4" with NO total,
  and NOTHING sits beside the step's own title — a round counter lived there through three shapes
  (a total, a settled count, the edit round in flight) and every one of them invited a comparison
  with the deck's numbering an inch below. That a round is running is already said by the pulsing
  cell in the matrix, the activity feed, and the seat's state chip;
  because a round that rewrote nothing writes no version and a denominator promised a card the pager
  could not reach. Such a round keeps its card — it carries a review — and says "reviewed again,
  unchanged" instead of taking a number.
- Round deck: one sub-card per VERSION of the step, not per round. A round that rewrote nothing
  wrote no version, so it gets no card — its review rides the version it actually read, which is
  why a position that ends on a Pass has no trailing card repeating the previous text. Every
  round's review still appears exactly once. A step the walk has reached but recorded nothing for
  yet reports what its seat is doing ("round 1 in progress — commentors are working") instead of
  reading as untouched. Cards are NEWEST ON TOP (round k sits over
  round k−1), paged exactly like the seats: the same ghost prev/next chevrons hugging the
  "Round k / K" title in the card header (disabled dim at either end) — where K is the last round
  that HAS a card, never the highest round number that occurred: counting to a round the deck
  cannot show promised a card the pager could not reach. For the same reason the step card's own
  header carries no round count beside the deck: the deck counts versions and a review count counts
  rounds, and a step reviewed four times whose fourth round rewrote nothing pages to "Round 3 / 3",
  so the two numbers side by side read as a missing card. How many times a step was reviewed rides
  the hover on its "Step n / N" title instead, and the header keeps only what is still happening
  ("round 4 in progress", or "unfinished" once the seat is dismissed). The header also carries
  the verdict chip, a "redeveloped" badge, and a copy icon that copies the round as a
  plain-text bug report (seat, step, round, verdict, issues, texts). The deck's BASE is the
  "Original thought" card — the step's first-pass text, the one card rendered at full weight in
  its entirety — so every later card's full-weight words are exactly what that version changed,
  and Round 1 is compared against the original like any other version (a round that rewrote
  nothing renders fully dimmed with an "unchanged this round" note). The base card joins only
  decks that have at least one round or cross-rewrite; an untouched step keeps its pending card.
- No card says which of a step's versions it is. Every card that was not the newest used to carry
  "an earlier version", which restated what the pager arrows already show and labeled most of the
  deck for no decision it helped anyone make.
- **Every version card carries a grey brain icon beside its copy icon** when the run recorded the
  thinking behind that version. Hovering it (or focusing) opens a scrollable window — dressed like
  the live thread (muted surface, dim mono), never like an artifact — holding the recorded
  per-step slice of the author's native-thinking stream: the SAME words the panel streamed live
  while that version was being written, kept now as the task's captured trace. The "Original
  thought" card shows the first-pass slice; a round's own card shows the redeveloper's slice for
  the step it rewrote; a cross-edit card shows the origin round's slice for the step it landed
  on. The preview is fetched on demand (GET /api/jobs/:id/thoughts?ref=…) and cached — thoughts
  are large and never ride the job snapshots. No icon renders when nothing was recorded: a
  withheld thinking channel is a normal answer, and a control that opens on emptiness reads as
  broken.
- **Clicking the brain downloads the whole text as a file** (GET /api/jobs/:id/thoughts.txt?ref=…,
  named like `thoughts-seat-3-develop-idea-step-2.txt`); hovering it colors the icon accent, since
  unlike its grey ghost-button neighbours this control goes somewhere. The preview shows at most
  the first four paragraphs of the journal's slice (the file is one click away, so the hover
  window stopped being a reading surface for whole traces); the slice itself is CAPPED at capture
  time so checkpoints stay bounded, and the download is re-cut untruncated from the task's own
  `.thinking.json` artifact (runs whose artifact is gone get the capped slice — the most that
  still exists). A preview that was cut — by the paragraph cap or the capture-time mark — ends in
  "… [download full version]": the brackets stay quiet prose, the words are the link, and the
  download runs through a detached anchor with selection disabled, because a press that drifts a
  few pixels otherwise becomes a drag-select and a drag-selected link click navigates nowhere.
- **First-pass cards carry the same brain icon in their header**, holding the thinking recorded
  while that seat wrote its FIRST version — a whole-task handle (the develop task's entire trace,
  step-headed in the preview, the raw stream in the download) rather than one step's slice.
- Round text: the step text as it came OUT of that round (its number is an identity, not a
  verdict — that round's verdict rides with its comments, one card back), full height, never
  clamped or scrolled. Words carried from earlier rounds render dimmed; the round's own changes
  render at full weight (round 1 is all full-weight — nothing was reviewed before it). When the
  round's revision also rewrote OTHER steps, the card carries one line per rewritten step —
  "prospectively edited step 5", at the CARD's text size rather than the small-label size, because
  it is a sentence about the card and not a label prefixing a value — and the STEP is the colored,
  clickable half: it takes the
  direction's color and OPENS step 5's own card for that very rewrite, selecting it in that
  step's deck and scrolling to it. The rewritten text itself is never shown here. The deck key
  the two sides agree on has ONE definition (`crossEntryKey`), because a second copy of the
  format would link nowhere and read as a dead control.
- **A version's length never costs it its highlighting.** The diff has no token ceiling: a
  common prefix and suffix are matched off linearly, the exact word LCS runs while its table fits
  the cell budget, and past that the two versions are aligned clause by clause and each gap
  between two matched clauses is diffed on its own. A flat 1200-token ceiling used to sit there,
  and above it every word came back marked changed — which renders as a card with NO dimming, so
  the treatment silently inverted its meaning on exactly the late-round versions whose changes
  matter most (a step's text carries no length limit and grows with every redevelopment; the
  early, short versions highlighted correctly, which is why it read as "highlighting stops
  working after round 1"). Segments are exact SLICES of the version — the space after a word
  travels with it — so the spans reassemble the text as the model wrote it, spacing included.
- A diff is computed when a card is opened, never in advance, and a seat's timeline is memoized
  against a fingerprint of its recorded text. The deck shows one version at a time, so diffing
  every version of every step to paint seven cards would spend the whole walk's work per render —
  and a running job re-renders on every progress event.
- A cross-step rewrite is ITS OWN card in the AFFECTED step's round deck, placed in true
  chronological position — before the step's own rounds when an earlier walk position caused
  it, after them when a later one did. The card is labeled "edited prospectively/retroactively
  during the review of step N" (hover names the exact origin round) and shows the step's updated
  text with the changed words colored — color only, no background tint, no underline — and
  carried words dimmed. The DIRECTION is the color, and it colors exactly ONE word, the adverb:
  `--prospective` dark blue when an EARLIER position's review rewrote this later step
  (prospective), `--bad` red when a LATER position reached back (retroactive). The rest of the
  label is ordinary text, so a deck of these cards reads as sentences instead of as colored
  headings. A step's own-round
  changes keep the normal full-weight-over-dimmed treatment. The step's own "Round k / K"
  numbering never shifts around these cards, and older cards keep the step's history
  untouched. The "redeveloped" badge belongs to the review shown on the card — it says THIS
  version was sent back — not to the round that wrote the text, so it travels with the comments.
- A seat's output downloads as LaTeX from the first version onward, not only once its walk has
  finished: the output exists as soon as the seat has thought, and a reader watching a run that will
  take hours has every reason to want the current draft in hand. A mid-review copy names itself
  `seat_3_draft.tex` so it cannot be confused with the `seat_3.tex` the same seat will produce when
  the review closes.
- Comments panel: under the text the comments were actually made against, collapsed by default.
  A round is handed a text, gathers comments on it, and only then redevelops, so round k's
  comments describe the version the PREVIOUS card shows: every card carries the review of the
  version it displays, which puts round 1's comments under "Original thought" and leaves the
  newest version unreviewed until a later round reads it. The summary row names no round: the panel already
  sits on the version its review was made against, so a number there only invited comparison
  with the card's own numbering, which counts the round that WROTE the text rather than the one
  that judged it. The reviewer names ride ON the
  summary row itself, right after the "Comments & judgement" label — Judge first,
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
- **The MAIN section's changes are tracked**, the way the chain deck tracks steps — but for the
  output body alone (never the chain, the novelty claim, or the papers, which have their own
  records). Two views of the same record:
  - a **Changes tab** on the final-version fold, comparing the LATEST version against the FIRST:
    carried words dimmed exactly like a round card's, additions in accent at full weight, and —
    unlike the chain deck, whose paging implies them — deletions shown in place, struck through
    in red. The tab appears only when something actually changed. The comparison is computed
    client-side from the two versions already on the wire, with the diff and the text projection
    both imported from protocol, so the tab and the document below can never disagree;
  - an **edit-icon download** (pencil, in the tab row) saving the whole history as markdown
    (`GET /api/jobs/:id/members/:memberId/output-changes.md`): the first version in full, then one
    section per review moment ("Step k · round r", the deck's own coordinates) documenting what
    that redevelopment changed — additions bold, removals struck, a no-op round saying so
    explicitly. Built from the server's replay of every intermediate version (a patch names only
    what it changes, so only the replay knows what stood between first and latest); the versions
    ride the fingerprint-cached detail build and never the JobDetail wire, because they repeat
    the whole body once per revision.
  The projection that turns a shape body into diffable text is GENERIC over the body's fields
  (labels from field names, arrays stacked, nested objects joined) rather than a hand-written
  mirror per shape — a new shape is tracked the day it ships, and the projection cannot drift
  from a renderer it never copied.
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

A failed stage shows the error string in a `--bad`-tinted box inside its panel; downstream
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

### Stage transitions read as one continuous run

Every gate crossing passes through internal states — the run suspends at the gate, the answer
(the submitter's or the countdown's) submits a resume, and the job sits "queued" until a worker
picks it up, which a scheduler queue can stretch to minutes. None of that machinery is the
user's: the dashboard used to flash an amber strip for "suspended" and again for "queued", and
reset every stage to "pending" for the whole queued window, so a routine Process → Decompose
transition read as two alarms and a wiped run.

The rules that keep the transition smooth:

- **Recorded progress stands.** A queued job with a checkpoint keeps every stage exactly as
  derived from the journal and artifacts; only a job with NOTHING recorded (a fresh submission,
  or one resubmitted before its first checkpoint) is all-pending while queued.
- **An answered gate never re-offers.** While the resume is queued, the checkpoint on disk still
  says "suspended with a pending gate"; the server records the ANSWER on the job the moment the
  resume is submitted, and the mapper shows the decision (approved / shrunk / revised, with the
  kept-plus-added panel) through the window. The journal's own recorded response supersedes it
  the moment the resumed run writes one.
- **The words are the run's, not the scheduler's.** The header chip reads "waiting for you"
  while a gate waits and "continuing…" while a mid-run resume sits in the queue ("queued" stays
  for a fresh submission, where the wait is real and worth naming); the landing card says
  "continuing from checkpoint…".
- **The amber state strip is for states that need the user** — the credit window, a failure, an
  interruption. Suspended and queued draw no strip: the gate card, the header word, and the
  stages themselves already say what is happening.

## Live updates

The dashboard subscribes to `GET /api/jobs/:id/stream` (SSE, full `JobDetail` snapshots,
throttled server-side). Reconnect with backoff; while disconnected show a thin `--warn` line
"reconnecting…" under the header. The shared workspace overview subscribes to `/api/stream` while the home or History is visible.

## Non-goals (v1)

No auth, no multi-user, and no editing generated artifacts from the UI.

## Performance boundaries and validation

The shell lazy-loads the research library, run dashboard, full settings, compact quick editors,
file browser, and background renderers. Quick settings load when the rail menu opens; model options
and registry details load only when their editor needs them. Decoration pauses while a research dashboard is open. Hover prefetch is deduplicated and limited to two requests. Retained detail
snapshots have an LRU limit of six entries, five minutes, and 16 MiB of decoded response-text weight
(the budget is a proxy, not a measurement of JavaScript heap size). Oversized active jobs still work
but are not retained in that cache.

SSE frames are delivered in bounded batches with up to 50 ms added latency. Full snapshots may
supersede earlier ones; ordered live text append/reset/end events are preserved. Settings writes
from all editors share one ordered queue; concurrent reads share transport and retry if a write
supersedes their response. Failed writes do not block later edits.

These controls bound frontend rendering and retained detail data. The current server still sends
all history summaries and full active-job snapshots; very large archives can require server-side
pagination, indexing, and smaller snapshot contracts. This change does not claim unlimited data
capacity or measured end-to-end latency at production scale.

`npm run test -w brainstorm-agentic-web` covers build and pure behavior. Browser regressions run
with `npm run test:e2e -w brainstorm-agentic-web`: API writes are mocked, so tests cannot start
real research, alter credentials, or submit SLURM jobs. Browser coverage includes landscape/portrait
layouts, nested quick menus, pill toggles, compact editor focus/dismissal, settings save and close
behavior, submission contracts, bounded history rendering,
background lifecycle, floating-panel dismissal and keyboard access, narrow-screen bounds, and exact
main-view/draft preservation across library navigation. Large-list tests use 10,000 mocked summaries
and verify bounded DOM rendering without bulk detail requests.
