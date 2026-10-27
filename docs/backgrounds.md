# Application backgrounds and appearance

The implementation lives in `apps/web/src/backgrounds`. The background is decoration. It does not subscribe to jobs, imply that
a run is working, or own a server connection. The foreground remains available if
the selected renderer cannot load or draw.

## Application and settings integration

```tsx
import {
  BackgroundLayer, backgroundOptions, setAppearance, useAppearance,
} from "./backgrounds";

function Shell() {
  const appearance = useAppearance();
  return <>
    <BackgroundLayer subdued={false} paused={false} />
    <main style={{ position: "relative", zIndex: 1 }}>
      <label>Background
        <select value={appearance.background}
          onChange={(event) => {
            const choice = backgroundOptions.find(({ id }) => id === event.target.value);
            if (choice) setAppearance({ background: choice.id });
          }}>
          {backgroundOptions.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
    </main>
  </>;
}
```

`useAppearance()` uses one `useSyncExternalStore` store. Its snapshot contains
`theme` (`system`, `light`, `dark`), `background`, `motion`, `quality` (`low`,
`balanced`), `resolvedTheme`, `reducedMotion`, `effectiveMotion`, and `persisted`.
The last property reports whether local preference storage was available. Controls
should explain a failed save while allowing the current tab's choice to work.

`setAppearance(patch)` merges and validates the four preferences, applies them
immediately, and returns whether persistence succeeded. Storage is local to the
browser under `brain.appearance.v1`, in a versioned envelope. Only those four fields
are saved; do not pass run data, credentials, or server settings through this store.
Unknown versions and invalid values use safe defaults. The previous `brain-theme`
value is migrated, and kept compatible with the existing early theme bootstrap.
Other tabs follow preference changes. System theme and reduced motion follow OS
changes without reloading the page.

The layer is fixed at `z-index: 0`, has `aria-hidden`, and cannot intercept pointer
events. Foreground application content must use a higher stacking layer. `subdued`
lowers the decoration's opacity without dimming the foreground. `paused` is an
optional performance policy that freezes decoration; it never stops job streams.
For example, the shell can pause it during an expensive foreground operation.

## Add a custom background

Backgrounds are reviewed source modules bundled with the application. They are not
remote JavaScript URLs, user uploads, or code downloaded from the Brain registry.

1. Add an `id`, `label`, and description to `src/backgrounds/catalog.ts`. This also
   extends the `BackgroundId` type and the appearance validator.
2. Add a renderer module. For a Canvas2D design, use the shared lifecycle:

   ```ts
   import { canvasRenderer } from "./canvas-renderer";

   export const mountMyBackground = canvasRenderer(({ context, width, height, time, dark }) => {
     // Draw within the supplied viewport. `time` advances only while animated.
     context.strokeStyle = dark ? "rgba(160,190,240,.2)" : "rgba(70,100,140,.15)";
     context.beginPath();
     context.moveTo(0, height * 0.5);
     context.quadraticCurveTo(width * 0.5, height * (0.4 + Math.sin(time) * 0.02), width, height * 0.5);
     context.stroke();
   });
   ```

3. Add its lazy import to the exhaustive loader map in `src/backgrounds/registry.ts`.
   The application and settings list load metadata immediately; renderer code loads
   only when selected. No shell or settings component changes are needed.

   ```ts
   myBackground: () => loadOptionalModule(() => import("./my-background"))
     .then((module) => module.mountMyBackground),
   ```

   Keep the `loadOptionalModule` wrapper: it lets renderer download failures reach
   their local fallback without triggering the application's critical-module reload.
   The foreground draft and any open windows remain in place.

An advanced renderer can implement `BackgroundFactory` directly. It receives
`container`, `theme`, `motion`, `quality`, `paused`, `signal`, and `onError`; it returns
`update(state)` and an idempotent `dispose()`. It must respect aborted signals,
reduced motion, hidden tabs, changes to viewport dimensions, and quality budgets.
Use `onError(error)` for asynchronous failures. The host cancels and removes a
failed renderer and displays the plain theme surface. It logs a diagnostic in
development, without replacing the saved choice. Switching to another background
and back attempts to mount it again. A failed module download can require a page
reload if the browser cached the failed import.

Never add focusable controls or application state to a renderer. Avoid network
requests and dependencies on foreground layout. Stop timers, RAF callbacks and
event listeners on disposal, and free any backing canvases or graphics resources.

## Performance and behavior

The built-in designs use Canvas2D with no React state updates per animation frame.
Balanced quality limits the backing surface to 1.6 million pixels, DPR 1.5, and
24 rendered frames per second. Low quality limits it to 650,000 pixels, DPR 1,
and 12 rendered frames per second. The actual frame rate can be lower on busy
devices. Pixel budgets apply independently of screen aspect ratio and job count.
The visual field uses both viewport dimensions, without assuming a 16:9 display.

Reduced motion, motion disabled, and `paused` draw a still frame and stop animation
scheduling. Hidden tabs stop scheduling entirely. Resize and appearance changes
can redraw a still frame. Selecting `none` loads no renderer and creates no canvas.
The renderer removes its bitmap and listeners when switched or unmounted.

The pure tests in `apps/web/test/backgrounds.test.ts` cover storage validation,
legacy migration, persistence whitelisting, and rendering budgets. The Playwright
suite in `apps/web/e2e/backgrounds.spec.ts` covers switching designs, OS theme and
reduced-motion changes, visibility events, a failed lazy import or painter, narrow
and ultrawide windows, and preserved access to the foreground. Visibility is
simulated with the document visibility event because headless tabs do not reliably
enter a background state. All server API calls use fixtures.
