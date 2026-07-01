# PRD-001c: API aggregation (server-side BFF proxy)

> Parent: [`prd-001-thehive-portal-daemon-index.md`](./prd-001-thehive-portal-daemon-index.md)

## Overview

This sub-PRD delivers thehive's data federation: how the dashboard gets each row from the daemon that owns it. It implements hivenectar [`ADR-0004`](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) decision #2 (thehive holds **no** Deep Lake client and fetches every dashboard row from the owning daemon's HTTP API, fail-soft per daemon) via the **server-side proxy** mechanism recorded in [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md).

The browser talks to **thehive's origin only**. The copied dashboard `wire` (`the-hive/src/dashboard/web/wire.ts`) fetches same-origin relative paths (`/api/*`, `/setup/*`, `/health`) exactly as honeycomb's original same-origin dashboard did. thehive's **server** owns federation: a proxy handler (`the-hive/src/daemon/proxy.ts`, mounted `app.all("/api/*")` + `app.all("/setup/*")` in `the-hive/src/daemon/server.ts`) resolves the owning daemon per request from hivedoctor's registry, fetches it over loopback, and streams the response back.

This replaces the earlier **client-side** federation (the browser fetching each daemon's origin directly through a `/api/daemon-bases` table and a `buildFederatedUrl` rewrite). That mechanism forced a CORS allowance onto every workload daemon and pushed the loopback-trust decision into the browser; the reasons for the change are recorded in [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md).

## Goals

- The browser fetches dashboard data same-origin from thehive; it never issues a cross-origin request to a workload daemon.
- thehive's server routes each `/api/*` and `/setup/*` request to the owning daemon's loopback base, resolved from hivedoctor's registry, and streams the response back.
- Aggregation is fail-soft per daemon: one daemon down degrades its panels (a 502 the wire renders as empty/unreachable) while the rest of the dashboard renders.
- thehive holds no Deep Lake client, no tenancy scope, and no query surface (ADR-0004 decision #2).
- Auth is transparent pass-through: thehive forwards the browser's own request headers to the workload daemon and stores no credential of its own.
- No workload daemon needs CORS: because the browser is same-origin to thehive, honeycomb's dashboard CORS middleware is removed.

## Non-Goals

- The dashboard components that consume `wire` (copied in [`prd-001b`](./prd-001b-dashboard-migration-and-copy-map.md)); they are unchanged and consume `wire` through `PageProps`.
- hivedoctor's registry schema and file (owned by hivedoctor's PRD-004a); thehive reads it as the routing source.
- The workload daemons' own `/api/*` shapes; honeycomb's are at `honeycomb/src/daemon/runtime/server.ts:73-107`, hivenectar's Source Graph API is its own PRD. thehive proxies them, does not define them.
- Real-time streaming of dashboard data. Freshness stays interval polling (proxied same-origin); server-sent events are a future direction recorded in [`ADR-0003`](../../../knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md).

---

## User stories + acceptance criteria

### US-1 - same-origin browser, server-side routing

**As** a dashboard page, **when** I request data, **I** fetch it from thehive same-origin and thehive proxies it to the daemon that owns it.

| ID | Criterion |
|---|---|
| c-AC-1 | Given a dashboard endpoint (for example `/api/memories`, `/api/graph`, `/api/diagnostics/*` per `the-hive/src/dashboard/web/wire.ts` and `honeycomb/src/daemon/runtime/server.ts:73-107`), when a page requests it, then the browser fetches thehive's own origin and thehive's proxy (`the-hive/src/daemon/proxy.ts`) forwards it to the OWNING daemon's `/api/*` base over loopback. |
| c-AC-2 | Given hivenectar exposes `/api/source-graph/*`, when a page owned by hivenectar requests data, then thehive's proxy routes that request to hivenectar's base (via `resolveEndpointOwner`), distinct from honeycomb's. |
| c-AC-8 | Given thehive's own routes (`/health`, `/api/fleet-status`), when they are requested, then thehive serves them itself rather than proxying (they are registered ahead of the `/api/*` catch-all). |

### US-2 - fail-soft aggregation

**As** an operator, **when** one daemon is down, **I** still see the rest of the dashboard.

| ID | Criterion |
|---|---|
| c-AC-3 | Given honeycomb's API is unreachable, when the dashboard loads, then the proxy returns a fail-soft 502 for honeycomb-owned endpoints (which the wire renders as unreachable/empty) while hivenectar-owned panels still render. |
| c-AC-4 | Given a malformed or partial response from a daemon, when `wire` parses it, then it degrades to the safe empty/zero state via the reused zod schemas rather than throwing into React (preserving honeycomb's `wire` posture). |

### US-3 - no second data plane

**As** an architect, **when** I audit thehive, **I** find no Deep Lake client.

| ID | Criterion |
|---|---|
| c-AC-5 | Given thehive's implementation, when it is audited, then it holds no Deep Lake client, resolves no tenancy scope, and runs no queries; all data arrives over daemon `/api/*` proxied by thehive (ADR-0004 decision #2). |

### US-4 - transparent auth + no CORS burden

**As** a security reviewer, **when** I audit the federation path, **I** find thehive holds no credential and no workload daemon needs a CORS allowance.

| ID | Criterion |
|---|---|
| c-AC-6 | Given the proxy, when it forwards a request, then it passes the browser's session/auth headers through verbatim (stripping only `host` + hop-by-hop headers) and stores no credential of its own. |
| c-AC-7 | Given the SSRF surface, when the proxy resolves a daemon base, then it only ever targets a loopback origin (`resolveDaemonBases` drops non-loopback registry entries; the proxy re-checks `isLoopbackBaseUrl` and pins `redirect: "error"`), and no workload daemon emits CORS headers for the dashboard (honeycomb's dashboard CORS middleware is removed). |

---

## Implementation notes

### Same-origin wire, server-side proxy

The copied `wire` keeps honeycomb's `ENDPOINTS` map and the per-endpoint zod schemas verbatim, because the wire truth (what each `/api/*` returns) is unchanged. What changed from the first cut is that the `wire` fetches **same-origin** (its `origin` prefix is empty), and the per-endpoint daemon-base routing moved OUT of the browser and INTO thehive's server. The `buildFederatedUrl`/`createFederatedFetch`/`loadDaemonBases` client helpers and the `/api/daemon-bases` route are removed.

### The proxy resolves the owner from hivedoctor's registry

thehive's proxy handler resolves the owning daemon per request with `resolveEndpointOwner` (`the-hive/src/shared/daemon-routing.ts`: anything under `/api/source-graph` is hivenectar, everything else honeycomb) and that daemon's loopback base with `resolveDaemonBases` (`the-hive/src/daemon/registry.ts`, reading hivedoctor's `hivedoctor.daemons.json`). It forwards method + pass-through headers + body, pins `redirect: "error"`, and streams the upstream response back. A daemon absent from the registry falls back to its documented loopback default; a failed fetch returns the fail-soft 502 (c-AC-3).

### Routing table (open question resolved)

The initial endpoint-to-owner table is: **everything the migrated pages fetch is honeycomb-owned except `/api/source-graph/*`, which is hivenectar-owned.** This matches honeycomb's mounted groups (`honeycomb/src/daemon/runtime/server.ts:73-107`) and hivenectar's Source Graph API. New workload daemons join by exposing an `/api/*` surface and registering; extending `resolveEndpointOwner` is the only thehive change needed for a new owner prefix.

### Fail-soft + no Deep Lake client

The proxy isolates failures per daemon (a fetch error, a blocked redirect, or a non-loopback base → a 502 for that daemon's endpoints, never an exception that blanks the page). Combined with the reused zod parse (which degrades malformed payloads to safe empty state, c-AC-4), the dashboard is resilient to any subset of daemons being down, the always-on property ([`prd-001a`](./prd-001a-thehive-process-and-bootstrap.md), ADR-0004 decision #1) carried through to the data layer. thehive still holds no Deep Lake client: every row arrives over a proxied daemon `/api/*` (c-AC-5).

## Related

- [`ADR-0002-server-side-bff-proxy-for-dashboard-federation.md`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) - the decision this sub-PRD implements.
- [`ADR-0003-future-sse-streaming-for-dashboard-freshness.md`](../../../knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md) - the future freshness direction (polling stays for now).
- [`prd-001b-dashboard-migration-and-copy-map.md`](./prd-001b-dashboard-migration-and-copy-map.md) - marks `wire.ts` as the load-bearing modification; its base resolution is what this sub-PRD moved server-side.
- [`prd-001d-service-unit-and-registration.md`](./prd-001d-service-unit-and-registration.md) - the registry entries the proxy resolves daemon bases from.
- [hivenectar ADR-0004](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) - decision #2 (API aggregation, not Deep Lake) this sub-PRD realizes.
- `the-hive/src/daemon/proxy.ts`, `the-hive/src/daemon/server.ts`, `the-hive/src/shared/daemon-routing.ts`, `the-hive/src/daemon/registry.ts` - the proxy, its mount, the owner routing, and the base resolution.
- `honeycomb/src/daemon/runtime/server.ts:73-107, 319-341` - the `/api/*` groups and `/health` thehive proxies (its CORS middleware removed).
