# Pages Inventory Deep Dive

> Category: Frontend | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

Read this if you work on any specific dashboard page: it walks every registry page and the shared empty-state components, giving each page's data source, its states, and its notable components, so you can go from a route to the exact wire calls and files behind it.

**Related:**
- [spa-architecture.md](./spa-architecture.md)
- [wire-and-data-fetch.md](./wire-and-data-fetch.md)
- [hive-graph-and-graph-pages.md](./hive-graph-and-graph-pages.md)
- [fleet-telemetry-client.md](./fleet-telemetry-client.md)
- [dashboard-surface.md](./dashboard-surface.md)
- [../integrations/workload-endpoint-inventory.md](../integrations/workload-endpoint-inventory.md)
---

## How to read this

Every page is one entry in `ROUTES` (`registry.tsx`) plus one component under `pages/`. They all share the same contract: take `PageProps`, use the injected `wire` (never `createWireClient`), hydrate on `usePoll` with the tab-hidden guard, wrap content in `PageFrame`, and render escaped React text with no `dangerouslySetInnerHTML`. Money is integer cents in view-models and formatted only at the render edge. None of them holds a token or a secret. The recurring state pattern is loading, empty (honest, never a fake zero), degraded (fail-soft when a daemon flaps), and, for project-scoped pages, a `NeedsProjectSelection` gate. What follows is per-page: source, states, and the components worth knowing.

The two graph pages (`/graph`, `/hive-graph`) have their own doc, [hive-graph-and-graph-pages.md](./hive-graph-and-graph-pages.md), and are only summarized here.

## Dashboard (`/`, `DashboardPage`)

The zoned home. Three named area landmarks: a KPI band (the per-subsystem health strip plus four headline KPIs: Memories, Turns, Est. savings, Team skills), a recall area (the recall bar plus recalled-memory cards plus the lexical-fallback badge), and a harness area (the `HarnessStrip` plus the two-column grid and the full live log). It hydrates from the shared wire: KPIs, the recall POST (`wire.recall`), the live log poll on `LOG_POLL_MS = 2500` (`wire.logs`, capped at `MAX_LOG_LINES = 8`), and the harness poll on `HARNESS_POLL_MS = 5000`. It reads the shell-owned `pollinating` flag rather than owning its own Pollinate action or header. On a workspace with zero bound projects the dashboard's primary content becomes the `FirstRunBindCTA` from `needs-project.tsx` (a "pick a folder to start" call to action behind the `FolderPicker`), gated in `app.tsx` on `projectsHydrated && !hasBound`.

## Memories (`/memories`, `MemoriesPage`)

The full memory-management surface, project-scoped (shows `NeedsProjectSelection` without a project). Three concerns on one page:

- **Browse, search, view.** A paginated list from `GET /api/memories` (newest-first, "load more" bumps the limit), a search box that POSTs `/api/memories/recall` and swaps the list for ranked hits with score and the lexical-fallback badge, and a detail view from `GET /api/memories/:id` showing full content plus scope/type/source/version/embedding-presence. An unknown id renders an honest "forgotten" state.
- **Add and edit (versioned).** An add form POSTs `/api/memories`; an edit POSTs the modify route with content plus a required reason. After any write the page re-reads and polls to convergence (Deep Lake is eventually consistent), never optimistic. Forget is behind a confirm.
- **Compact, pollinate, watch.** Compact (behind a confirm) POSTs `/api/diagnostics/compact` and renders the real per-table summary; Pollinate reuses the shell's honest ack; Watch toggles the log poll filtered to memory routes.

Memory type metadata comes from the copied `src/shared/memory-types.ts` (`MEMORY_TYPES`, `MEMORY_TYPE_DESCRIPTIONS`, `DEFAULT_MEMORY_TYPE`). The page also mounts `LifecycleHealthPanel` (see below).

## Lifecycle panel (`LifecycleHealthPanel`, mounted on Memories)

Not a route of its own; it renders inside the Memories page as the operator surface for the four lifecycle engines. It reads the shared wire for an aggregate health badge, freshness, open-conflict count, stale-ref count, and calibration ECE. The conflict queue has a per-conflict resolve action (`POST /api/memories/conflicts/:id/resolve`) that polls to convergence on a fixed budget (`RESOLVE_POLL_ATTEMPTS = 6`, `RESOLVE_POLL_DELAY_MS = 150`). It reads the stale-reference list (`/api/memories/stale-refs`), the history (`/api/memories/history`), and the calibration payload (`/api/memories/calibration`, ECE/Brier plus a reliability diagram). A term whose producing engine is off renders inert (an honest empty state), not an error: calibration dormant shows "calibration dormant", an empty queue shows "no open conflicts".

## ROI (`/roi`, `RoiPage`)

The Net-ROI ledger, a pure function of the `RoiView` the daemon assembles. It switches each section on its `status` discriminant and does no compute beyond two `usePoll` hydrations (billing and token) plus one fetch on trend-range change (`wire.roi`, `wire.roiTrend`). Measured versus modeled is carried by four reinforcing signals: badge tone (verified green vs warning amber), numeric weight, a literal `est.` marker with a leading `~`, and dashed vs solid chart strokes. Degraded states are explicit: a first-run empty renders a dash glyph (not `$0.00`), billing-unreachable dashes the line and the net with a scoped retry, and not-authenticated gates the ledger behind a Settings CTA rendering only redacted status. The section view-models come from the copied `src/dashboard/contracts.ts` ROI types.

## ROI chart (`RoiChartPage` / `roi-chart.tsx`)

The trend chart the ROI page hands its `RoiTrendView` to. An inline-SVG line chart in the `GraphCanvas` idiom with no charting dependency: one `<polyline>` per `RoiTrendSeries` over a bounded viewBox (`CHART_VIEW = { width: 640, height: 200 }`), a modeled series drawing a dashed stroke and a measured series a solid one. It is a pure function of the view the page fetched; it does no fetching. The cents range always includes zero so a negative net trend renders below the axis rather than flattening onto the baseline.

## Projects (`/projects`, `ProjectsPage`)

The steady-state project manager plus cross-device import. It lists every project the workspace is sourcing from `GET /api/diagnostics/scope/projects`, split on `boundLocally` (the active list is the locally-bound projects), and shows the reserved `__unsorted__` inbox distinctly (`UNSORTED_PROJECT_ID`). Each project shows bound path(s), git remote, last-capture, and memory/session counts, with honest dashes for absent fields and "never" for a missing last-capture. The top-right "+" offers "New folder" (the daemon-served `FolderPicker` bind flow) or "Import existing" (a modal listing the workspace's unbound registry projects via `?unbound=1`, binding a folder to a selected `project_id` via `POST projects/bind-existing`). Per-project unbind (`POST projects/unbind`) removes only the local binding; Open re-scopes the other surfaces via the scope context.

## Harnesses (`/harnesses` and `/harnesses/:name`, `HarnessesPage`)

Both the overview and the deep sub-route resolve to this one component (the registry prefix-match), and the page reads the active path via `usePathRoute` to decide which to render. The overview is six per-harness KPI cards plus an installed/active matrix hydrated from `GET /api/diagnostics/harnesses` on `STATUS_POLL_MS = 5000`, with uninstalled harnesses rendered honestly as greyed "not installed". The detail (`/harnesses/<name>`) shows the harness summary, its activity filtered client-side from the existing `/api/logs` stream on `STREAM_POLL_MS = 2500` (capped at `MAX_STREAM_LINES = 12`), and capability panels driven by the server-folded descriptor: a harness lacking a capability omits that panel (Cursor shows Agents, Claude Code does not). This is the page whose per-harness children are the sidebar's one dynamic nav group.

## Sync (`/sync`, `SyncPage`)

Skill and agent propagation, project-scoped. One shared component family renders both the skills and agents views, parameterized over asset kind rather than forked. It lists every skill/agent from the `installed ∪ synced` union view-model (`wire.assetsView()`) with an honest state badge (`local`/`pulled`/`shared`). Controls (promote, pull, demote, enable, disable) each dispatch to the real endpoint (`wire.syncAction`) and show an in-flight state until the daemon's poll-convergent read-back confirms; demote is disabled when not the author. The activity feed filters sync events (publish/pull/tombstone) from `/api/logs` newest-first, and a per-scope summary is derived from the same union view-model so the summary and the lists never disagree. Detail views omit the `native` blob, author email, and org GUID by construction.

## Logs (`/logs`, `LogsPage`)

Durable history plus a live tail plus a Turns drill-down, three surfaces on one page over the injected wire. The request-log tab has a collapsible live tail reusing `/api/logs/stream` (`wire.logsStream`, shared with the Sync feed) on top and a history table below fed by `/api/logs/history` (`wire.logsHistory`) with filter controls (time range, status/level including a `5xx` class, path exact/prefix, harness/org) that refetch page one plus cursor pagination. The tail and history share one `LogRow` renderer so they never drift, and are kept visually separate and not de-duped across each other. The Turns tab is a browsable list of captured turns (`wire.turnsHistory` to `/api/diagnostics/sessions`) with cursor pagination and a single-turn metadata drill-down; it is metadata only, never a transcript or body. Status renders as a level via existing Badge tones (2xx ok, 4xx warn, 5xx critical).

## Health (`/health`, `HealthPage`)

Hive-born, fed entirely by the shared `useFleetTelemetry` hook (SSE-first, REST fallback) with no second fetch loop. Per service it renders metrics since last restart (generically over whatever camelCase counter keys the service reports, via `humanizeMetricKey`), Deep Lake stats (connection state and last-communication time), and a live log tail with selectable verbosity (`LOG_LEVELS`, filtered by `filterLogsByVerbosity`, display-capped at `VISIBLE_LOG_LINES = 200` newest-first). This same literal path doubles as hive's machine-liveness probe via server-side content negotiation, so a full page load negotiates HTML-to-page vs anything-else-to-JSON; client navigation never touches the network. The full pipeline is in [fleet-telemetry-client.md](./fleet-telemetry-client.md).

## Settings (`/settings`, `SettingsPage`)

Three sections over the injected wire, with the token sacred throughout (no secret value ever enters page state, the DOM, a parsed response, or a log line). Deep Lake auth reads the redacted `wire.authStatus()` and renders it truthfully (connected org/workspace/agent, credentials source, expiry only when a real `expiresAt` exists), with a status-first CLI hand-off rather than an in-page device flow, re-reading on focus so a CLI login reflects. Provider API keys are write-only into the encrypted vault: one row per provider (Anthropic, OpenAI, OpenRouter, Cohere) with a password input, `wire.setSecret(name, value)` on save, and presence from `wire.secretNames()` (names only, there is no value-returning route), clearing the input and re-reading on success. Search mode plus migrated inference settings persist through the existing `vaultSettings()`/`setSetting()` surface (persist then re-read), reusing the shared `SettingsPanel`.

## The shared empty-state family

Three components exist once so pages do not duplicate empty-state markup, satisfying the duplication gate:

- `NeedsProjectSelection({ surface })` (`needs-project.tsx`) is the honest "pick a project to view its `<surface>`" panel the graph, memories, sync, and hive-graph pages render when no project is selected. `FirstRunBindCTA` in the same module is the dashboard's zero-bound-projects call to action.
- `FolderPicker` (`folder-picker.tsx`) is the only component that can return a real bindable absolute path, because a browser cannot: the daemon serves a dirs-only browse tree (`GET /api/diagnostics/fs/browse`) and the picker renders it, marks git repos, pre-fills a project name from the daemon's suggestion, and POSTs `projects/bind`. It degrades to a plain message plus the `honeycomb project bind` CLI hint when the daemon is unreachable.
- `BuildGraphButton` (`build-graph-button.tsx`) is the shared codebase-graph build trigger on both graph surfaces, wired to `POST /api/graph/build` (`wire.buildGraph()`), with a synchronous in-flight ref guarding against a double-click firing two POSTs, and an honest inline error on a `{ built: false }` ack.
- `ComingSoon({ title, ownerPrd })` (`coming-soon.tsx`) is the reachable empty-frame placeholder for a route whose content ships in a later PRD. In the current tree every registry route has real content, so this is the seam-proving fallback rather than a live surface.
- `HarnessStrip` (`harness-strip.tsx`) is the dashboard's home harness area (wired-in chips toned by last-seen recency, a short-tail live stream capped at `MAX_STREAM_LINES = 5`, and per-harness KPI tiles produced by mapping over the resolved installed set, so it is dynamic by construction with no literal six-harness array).
