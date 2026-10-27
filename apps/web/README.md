# Brainstorm App — Web

The production React + Vite client of Brain. A persistent canvas shell hosts the research composer,
a searchable floating history/trash panel, real pipeline views, and quick settings on the same page.
The panel uses a fixed, viewport-bounded width and preserves the active workspace without shifting it.
Click outside, press Escape, or choose New research or a run to dismiss it. It uses the server's typed HTTP/SSE
contract; research, attachments, model configuration, recovery, and execution controls remain real.
Credentials pass to the server for explicit verification and are never saved in browser storage.

The Settings rail menu opens nested controls: on/off settings use pill toggles, and choices stay in
the menu. Touch screens use one menu with Back navigation. Small numeric/text edits open compact
editors; connection setup, execution templates, and All settings open the centered settings window.
Scope labels distinguish browser preferences, defaults for new research, and changes to existing runs.

- [Interaction and architecture](docs/webapp-design.md)
- [Adding a custom animated background](../../docs/backgrounds.md)
- Protocol: `@brainstorm-agentic/protocol`

From the repository root:

```bash
npm install
npm run dev -w brainstorm-agentic-web     # Vite; proxies /api to localhost:8787
npm run build -w brainstorm-agentic-web   # typecheck and build dist/
npm run test -w brainstorm-agentic-web    # build and behavior regressions
npx playwright install chromium         # once, if no installed test browser
npm run test:e2e -w brainstorm-agentic-web
```

Browser tests intercept API requests and do not modify a real workspace. Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium installation. Production `dist/` is
served by Brain. The standalone demonstration remains separate under `prototypes/canvas/`.

Library rail controls belong in `src/shell/navigation.ts`; settings categories in
`src/components/settings/catalog.ts`. Quick-control definitions, field commands, and their shared
state live in `src/components/quick-controls/`; the generic menu handles desktop nesting and touch
drill-in. Reuse `SettingsToggle`/`ToggleMark` for on/off controls. Feature-specific UI and styles
belong in their own modules.
Use `src/sizing.css` for shared control, icon, spacing, radius, and touch-target dimensions.
Committee diagrams live in `src/components/committee/`. The pure model separates recorded
review contributions from layout and rendering: LED counts use the run's `cotSteps` and actual
chains, not the review-round budget. Scalar and part-aware comment targets are combined; Pass,
Interrupt, and legacy Build verdicts remain distinct. The same table serves first pass and review,
with a bulb node directly in front of each seat and its thinking LEDs ordered clockwise beside
it along the table rim. The diagram is its own stage-level card without zoom or an internal scroll area.
Characters sit 12 layout units from the rim, with permanent three-line expertise beside them.
Narrow screens and dense committees use a readable fixed roster below the diagram; long lines
truncate visually while retaining their full accessible text and seat-inspector access.
All controls sit below the diagram. The “Reviews by” checkboxes select source reviewers;
All, None, and multiple seats are distinct, and verdict toggles compose with that selection.
Only explicit filters change connection visibility. Live-only head motion, step inspection, and
independent browser-local colors for shapes, agent states, step states, and link verdicts live in
the committee modules.
Large edge sets use one canvas layer while members and LEDs remain accessible SVG controls.
Use Base UI menu/dialog/popover primitives for focus and dismissal, and the shared API layer for
settings mutations. Quick changes build field patches against current server settings inside the
shared write queue; do not keep independent mutable copies in individual menus. Main-view and
library-panel state are separate in `src/shell/routes.ts`;
library content and its shared live overview belong in `src/features/library/`. Keep animation outside research state. History rendering and cached detail
responses are bounded; the server still sends complete summary lists and active-job snapshots.

The Done page includes `FactTablePanel`, a human-facing view of the latest shared
facts in `DoneStage.factTable`. The card sits below the Done receipt and remains
visible for interrupted runs. It shows badge standing, claims, conditions, full
evidence, hashes and verification history, with filtering and a JSON download.
The usage column shows each recorded agent, role, step and purpose; submission,
citation and approval events stay distinct. Missing attribution stays explicit.
Search includes usage details. Plain HTTP(S) URLs and Markdown reference links
are clickable in the fact text, evidence, history and purposes; HTML stays text.
Missing journals, empty tables and read failures remain distinct. This UI does
not alter agents' fact-table access or the supreme judge's approval protocol.

## Desktop gateway compatibility

This research UI can be served by an independent desktop gateway. It always renders the
research application; host selection, SSH authentication, and connection controls belong to
the desktop application. No desktop React components or packages are imported here.

When the gateway sets `window.__CO_INFERENCE_LAUNCHER__ = { version: 1 }`, the dependency-free
helpers in `src/desktop/` bind a `/connections/:id/` page to `/connections/:id/api` for HTTP
requests, event streams, and downloads. Composer drafts, attachment references, onboarding,
and update notices use a connection-specific storage key; visual preferences stay shared.
Direct server deployments continue to use `/api` without the marker.

The gateway serves an independently built, pinned release of this UI and adds its own
connection-status bridge. Switching hosts performs a full navigation, clearing this page's
in-memory research caches.
