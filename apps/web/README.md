# Brainstorm App — Web

The frontend of the brainstorm system: a React + Vite single-page app with the chat landing page
(topic submission, server-side attachment picker, live job cards) and the per-stage pipeline
dashboard (activity feed, expertise tree with its literature grounding, review rounds with
verdicts and evidence, final proposal, credit-block countdown).

It is a pure client of the `brain` server: every request goes through the HTTP + SSE contract
defined in `@brainstorm-agentic/protocol`, and the production build (`dist/`) is served statically
by the server. The app holds no credentials and talks to no model provider.

- Design spec: `docs/webapp-design.md`
- API contract: `@brainstorm-agentic/protocol` (types only, no runtime dependency)

## Development

This module lives inside the Brainstorm app workspace. From `app/`:

```bash
npm install
npm run build -w brainstorm-agentic-web   # typecheck + Vite build into dist/
npm run test  -w brainstorm-agentic-web   # currently: the build
```

During development, run the `brain` server and rebuild on change; the server serves `dist/` with
an SPA fallback.
