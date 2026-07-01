# PRD-001b: dashboard migration and copy-map

> Parent: [`prd-001-thehive-portal-daemon-index.md`](./prd-001-thehive-portal-daemon-index.md)

## Overview

This sub-PRD is the file-by-file plan for moving the dashboard out of honeycomb and into thehive, implementing [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-thehive.md) Decisions A (retire honeycomb's dashboard) and B (copy-and-own, not runtime import).

The scope is the 36 files under `honeycomb/src/dashboard/**` (verified on disk). Each file gets a disposition: **copy verbatim**, **copy with modification**, **copy partially**, **net-new in thehive**, **stay in honeycomb**, or **delete from honeycomb (retire)**. The load-bearing property that makes most files copy verbatim: honeycomb's dashboard pages are already origin-agnostic. Each page takes `PageProps` and hydrates through an injected `wire` (`honeycomb/src/dashboard/web/registry.tsx:10-22, 83-94`), so the same component renders identically whether honeycomb or thehive supplies the `wire`.

## Goals

- A complete, disposition-tagged map of every `honeycomb/src/dashboard/**` file.
- thehive owns a working copy of the dashboard route registry, pages, and shell.
- honeycomb retires its `/` dashboard mount and `web/` subtree, keeping only its data plane and its non-web ViewBlock/TUI layer.
- A cutover sequence that never leaves operators dashboard-less.

## Non-Goals

- The `wire` federation internals (the one modified file whose logic changes most). Its same-origin fetch + thehive's server-side proxy are [`prd-001c`](./prd-001c-api-aggregation-wire.md); this sub-PRD only marks `wire.ts` as "copy with modification."
- The thehive process/host that serves the copied bundle. That is [`prd-001a`](./prd-001a-thehive-process-and-bootstrap.md) (the net-new host row below points at it).
- honeycomb's non-web ViewBlock/TUI dashboard, which stays in honeycomb untouched.

---

## File counts (36 total under `honeycomb/src/dashboard/**`)

| Disposition | Count | Summary |
|---|---|---|
| Copy verbatim to thehive | 24 | 12 `web/` shell/infra + 12 `web/pages/` (origin-agnostic; hydrate through the injected `wire`) |
| Copy with modification | 4 | `web/wire.ts`, `web/app.tsx`, `web/main.tsx`, `web/setup-gate.tsx` |
| Copy partially | 1 | `contracts.ts` (only the web-consumed ROI types `wire.ts:27` imports) |
| Net-new in thehive | 1 | the daemon-side host that serves the bundle (thehive's own Hono server, [`prd-001a`](./prd-001a-thehive-process-and-bootstrap.md)) |
| Stay in honeycomb | 7 | the ViewBlock/TUI layer that still powers the `honeycomb dashboard` CLI + Cursor webview |
| Delete from honeycomb (retire) | 28 web files + the `/` mount | the whole `web/` subtree + `honeycomb/src/daemon/runtime/server.ts:108` |

The 28 `web/` files that migrate to thehive (24 verbatim + 4 modified) are the same 28 deleted from honeycomb; the migration and the retirement are two ends of the one move. `contracts.ts` is copied partially and also **stays** in honeycomb (only a subset of its types crosses), so it appears in both "copy partially" and, implicitly, the honeycomb-retained set.

---

## Copy verbatim (24)

### `web/` shell + infra (12)

| File | Role |
|---|---|
| `honeycomb/src/dashboard/web/registry.tsx` | The route registry (`ROUTES`, `RouteEntry`, `matchRoute`, `DEFAULT_ROUTE`) at `honeycomb/src/dashboard/web/registry.tsx:196-240`; the single extension point for pages. |
| `honeycomb/src/dashboard/web/router.tsx` | The hash router outlet that mounts the active page. |
| `honeycomb/src/dashboard/web/sidebar.tsx` | The nav sidebar that reads `ROUTES`. |
| `honeycomb/src/dashboard/web/page-frame.tsx` | `PageFrame` + the `PageProps` type every page takes. |
| `honeycomb/src/dashboard/web/primitives.tsx` | Shared UI primitives. |
| `honeycomb/src/dashboard/web/panels.tsx` | The panel components used across pages. |
| `honeycomb/src/dashboard/web/scope-context.tsx` | The org/workspace/project scope React context. |
| `honeycomb/src/dashboard/web/needs-project.tsx` | The "no project bound" empty state. |
| `honeycomb/src/dashboard/web/folder-picker.tsx` | The bound-folder picker control. |
| `honeycomb/src/dashboard/web/harness-strip.tsx` | The installed-harness strip. |
| `honeycomb/src/dashboard/web/build-graph-button.tsx` | The graph-build trigger control. |
| `honeycomb/src/dashboard/web/graph-layout.ts` | The pure graph layout helper used by `pages/graph.tsx` and `panels.tsx`. |

### `web/pages/` (12)

| File | Route |
|---|---|
| `honeycomb/src/dashboard/web/pages/dashboard.tsx` | `/` (home overview) |
| `honeycomb/src/dashboard/web/pages/projects.tsx` | `/projects` |
| `honeycomb/src/dashboard/web/pages/harnesses.tsx` | `/harnesses` |
| `honeycomb/src/dashboard/web/pages/memories.tsx` | `/memories` |
| `honeycomb/src/dashboard/web/pages/graph.tsx` | `/graph` |
| `honeycomb/src/dashboard/web/pages/sync.tsx` | `/sync` |
| `honeycomb/src/dashboard/web/pages/logs.tsx` | `/logs` |
| `honeycomb/src/dashboard/web/pages/roi.tsx` | `/roi` |
| `honeycomb/src/dashboard/web/pages/roi-chart.tsx` | ROI chart child of `/roi` |
| `honeycomb/src/dashboard/web/pages/settings.tsx` | `/settings` |
| `honeycomb/src/dashboard/web/pages/lifecycle-panel.tsx` | lifecycle panel used by the overview |
| `honeycomb/src/dashboard/web/pages/coming-soon.tsx` | placeholder for unbuilt routes |

These are origin-agnostic: they import only `PageProps` + the shared `wire` and never bind a daemon URL themselves, so they render unchanged under thehive's same-origin `wire` (thehive's server proxies the data to the owning daemon).

---

## Copy with modification (4)

| File | Why it changes |
|---|---|
| `honeycomb/src/dashboard/web/wire.ts` | The single load-bearing modification. honeycomb's `wire` targets one same-origin daemon; thehive's copy stays same-origin to thehive, and thehive's SERVER proxies each endpoint to the **owning** daemon via hivedoctor's registry, fail-soft per daemon. The endpoint constants (`ENDPOINTS`) and the per-endpoint zod schemas are reused unchanged. Full design in [`prd-001c`](./prd-001c-api-aggregation-wire.md) / [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md). |
| `honeycomb/src/dashboard/web/app.tsx` | The app root wires the shell, scope context, and the `wire` instance. thehive injects its same-origin `wire` here (server-side federation lives in thehive's proxy, not the client). |
| `honeycomb/src/dashboard/web/main.tsx` | The browser entrypoint. Asset base and mount point adjust for thehive's host, and it hands the same-origin `wire` to `app.tsx`. |
| `honeycomb/src/dashboard/web/setup-gate.tsx` | The first-run/setup gate. Its "is the daemon set up" check moves from a single-daemon assumption to thehive's multi-daemon posture (a daemon still "starting" is not a hard block on the shell). |

---

## Copy partially (1)

| File | What crosses |
|---|---|
| `honeycomb/src/dashboard/contracts.ts` | Only the **web-consumed ROI view-model types** that `wire.ts` imports (`EMPTY_ROI_TREND`, `EMPTY_ROI_VIEW`, `RoiTrendView`, `RoiView` at `honeycomb/src/dashboard/web/wire.ts:27`). The rest of `contracts.ts` serves honeycomb's own daemon-side view-models and stays in honeycomb. thehive owns a small copy of just the types its `wire` validates against. |

---

## Net-new in thehive (1)

| File | Role |
|---|---|
| thehive's Hono host (new) | honeycomb served the SPA in-process via the `/` mount (`honeycomb/src/daemon/runtime/server.ts:108`). thehive is a separate process, so it needs its own host that serves the copied bundle. This is the process delivered by [`prd-001a`](./prd-001a-thehive-process-and-bootstrap.md), not a copied file. |

---

## Stay in honeycomb (7)

The renderer-agnostic ViewBlock/TUI layer at `honeycomb/src/dashboard/*` (not `web/`) is not part of the web portal. It powers the `honeycomb dashboard` CLI and the Cursor webview and is out of scope for this move.

| File | Role |
|---|---|
| `honeycomb/src/dashboard/dashboard.ts` | ViewBlock dashboard composition (CLI/webview). |
| `honeycomb/src/dashboard/views.ts` | ViewBlock view definitions. |
| `honeycomb/src/dashboard/html.ts` | ViewBlock HTML rendering. |
| `honeycomb/src/dashboard/launch.ts` | Dashboard launch helper. |
| `honeycomb/src/dashboard/logs.ts` | Log view for the ViewBlock layer. |
| `honeycomb/src/dashboard/index.ts` | The ViewBlock layer's barrel. |
| `honeycomb/src/dashboard/CONVENTIONS.md` | Conventions doc for the dashboard layer. |

`contracts.ts` also stays (only a subset is copied out).

---

## Delete from honeycomb (retire)

- The entire `honeycomb/src/dashboard/web/` subtree (28 files) once thehive serves the copied equivalent.
- The `/` dashboard mount: `honeycomb/src/daemon/runtime/server.ts:108` (`{ path: "/", protect: false, session: false }`).

honeycomb **keeps** its data plane: `/health` (`honeycomb/src/daemon/runtime/server.ts:319-341`) and the `/api/*` groups (`honeycomb/src/daemon/runtime/server.ts:73-107`) stay, because thehive aggregates them ([`prd-001c`](./prd-001c-api-aggregation-wire.md)).

---

## User stories + acceptance criteria

### US-1 - thehive serves the migrated dashboard

**As** a maintainer, **when** thehive serves the dashboard, **I** see the same route registry and pages honeycomb served, not a rewrite.

| ID | Criterion |
|---|---|
| b-AC-1 | Given the copied route registry, when thehive serves the dashboard, then it renders the same `ROUTES` entries (Dashboard, Projects, Harnesses, Memories, Memory Graph, Sync, Logs, ROI, Settings) from `honeycomb/src/dashboard/web/registry.tsx:196-218`. |
| b-AC-2 | Given a copied page component taking `PageProps`, when thehive mounts it, then it hydrates through the injected `wire` exactly as under honeycomb (`honeycomb/src/dashboard/web/registry.tsx:10-22`), with no page-level code change. |

### US-2 - honeycomb retires its dashboard without an outage

**As** an operator, **when** the dashboard moves to thehive, **I** am never left without a dashboard.

| ID | Criterion |
|---|---|
| b-AC-3 | Given the cutover, when honeycomb removes its `/` mount (`honeycomb/src/daemon/runtime/server.ts:108`), then thehive is already serving the dashboard first, so there is no window with no dashboard. |
| b-AC-4 | Given the retirement, when honeycomb's `web/` subtree is deleted, then honeycomb's `/health` and `/api/*` groups (`honeycomb/src/daemon/runtime/server.ts:73-107, 319-341`) remain intact for thehive to aggregate. |

### US-3 - the copy-map is complete and accurate

**As** an implementer, **when** I execute the migration, **I** have a disposition for every dashboard file.

| ID | Criterion |
|---|---|
| b-AC-5 | Given the 36 files under `honeycomb/src/dashboard/**`, when I check the copy-map, then every file has exactly one disposition and the counts reconcile (24 verbatim + 4 modified + 1 partial spanning the honeycomb-retained set + 7 stay + 1 net-new host = the full set, with 28 `web/` files retired from honeycomb). |

---

## Cutover sequencing (safeguard)

1. thehive ships, copies the `web/` subtree (verbatim + modified + partial), and serves the dashboard on 3853.
2. Operators verify thehive's dashboard renders and aggregates honeycomb + hivenectar.
3. Only then does honeycomb remove its `/` mount and delete the `web/` subtree.

This ordering keeps a dashboard available at every step. Reversing it (delete first, serve later) would leave a dashboard-less window, which Decision A explicitly forbids.

## Related

- [`ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-thehive`](../../../knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-thehive.md) - the retirement + copy-and-own decision this map implements.
- [`prd-001a-thehive-process-and-bootstrap.md`](./prd-001a-thehive-process-and-bootstrap.md) - the net-new host that serves the copied bundle.
- [`prd-001c-api-aggregation-wire.md`](./prd-001c-api-aggregation-wire.md) - the one load-bearing modification (`wire.ts` same-origin fetch + thehive's server-side proxy).
- `honeycomb/src/dashboard/web/registry.tsx:196-240` - the route registry copied verbatim.
- `honeycomb/src/dashboard/web/wire.ts:27, 34-40` - the ROI-type import + endpoint constants the same-origin `wire` reuses.
- `honeycomb/src/daemon/runtime/server.ts:73-108, 319-341` - the `/api/*` groups, the `/` mount (retired), and `/health` (kept).
