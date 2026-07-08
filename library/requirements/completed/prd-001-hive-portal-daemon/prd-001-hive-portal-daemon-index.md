# PRD-001: hive Portal Daemon

> **Status:** Completed
> **Priority:** P0
> **Effort:** L
> **Schema changes:** None (hive holds no Deep Lake client; it aggregates workload daemon APIs)

---

## Overview

PRD-001 is the foundational module for **hive**, the always-on **portal daemon** of the Apiary's three-daemon topology. hive boots with the device, is supervised by doctor like the other daemons, and serves the **unified dashboard** by aggregating each workload daemon's HTTP API rather than touching storage itself. It is the single source of always-on UI truth: the dashboard is up the moment the device boots, regardless of which workload daemon is healthy.

This module implements, as a **first-class product in the `hive` repository**, the four binding decisions recorded in nectar [`ADR-0004`](../../../../../nectar/library/knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md), the dashboard-migration decision in this repo's [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md), and the server-side federation decision in [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) (with [`ADR-0003`](../../../knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md) recording the future SSE freshness direction).

It adapts (does not paste) the contract from nectar's [`prd-004c-hive-portal-daemon`](../../../../../nectar/library/requirements/backlog/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) and [`prd-004d-hive-service-unit-and-registration`](../../../../../nectar/library/requirements/backlog/prd-004-doctor-registry-and-hive/prd-004d-hive-service-unit-and-registration.md). Two framings from those source PRDs are inverted here, per the two locked decisions below.

### Decision A (locked): honeycomb's dashboard is retired and moved to hive

The source PRD-004c hedged that "honeycomb may still serve its dashboard directly" and that hive "imports honeycomb's dashboard module rather than forking it." Both are superseded. honeycomb's `/` dashboard mount (`honeycomb/src/daemon/runtime/server.ts:108`) and its `honeycomb/src/dashboard/web/` subtree are **retired**; hive becomes the only dashboard. honeycomb keeps its data plane (`/api/*` + `/health`) because hive aggregates it. See [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md) Decision A.

### Decision B (locked): copy-and-own, not runtime import

Because hive is a separate repository from honeycomb and honeycomb's dashboard is retired, hive **copies** `honeycomb/src/dashboard/web/` into `hive` and owns it, rather than importing honeycomb's module at runtime. This is a one-time ownership transfer with source retirement, not a live fork. See [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md) Decision B. The file-by-file copy-map is [`prd-001b`](./prd-001b-dashboard-migration-and-copy-map.md).

### Decision C (locked): federate server-side (BFF proxy), not client-side

The source PRD-004c framed aggregation as hive's browser `wire` fetching each workload daemon's origin directly. That is superseded. The dashboard browser talks to **hive's origin only**; hive's **server** proxies each `/api/*` and `/setup/*` request over loopback to the owning daemon (`hive/src/daemon/proxy.ts`). This removes the CORS allowance every workload daemon would otherwise owe (honeycomb's dashboard CORS middleware is deleted) and keeps the loopback-trust decision server-side. Auth is transparent pass-through; hive stores no credential. See [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md); full design in [`prd-001c`](./prd-001c-api-aggregation-wire.md).

### Framing inversion (locked): first-class, not out-of-band

The source PRDs declared themselves "an out-of-band sub-PRD; it lands in the honeycomb repo, not nectar." In `hive`, hive **is the product**. Every "out-of-band / lands in honeycomb" framing is dropped; code citations into honeycomb and doctor carry a submodule prefix (`honeycomb/src/...`, `doctor/src/...`).

---

## Topology

```mermaid
flowchart TD
    os["OS service manager"] --> doctor["doctor - supervisor"]
    doctor -->|supervises| hive["hive - always-on portal (:3853)"]
    doctor -->|supervises| honeycomb["honeycomb - workload daemon (:3850)"]
    doctor -->|supervises| nectar["nectar - workload daemon (:3854)"]
    browser["Dashboard browser"] -->|"same-origin /api/*"| hive
    hive -->|"server-side proxy (loopback)"| honeycombApi["honeycomb /api/*"]
    hive -->|"server-side proxy (loopback)"| nectarApi["nectar /api/hive-graph/*"]
    honeycomb --> deeplake["Deep Lake"]
    nectar --> deeplake
```

hive holds no Deep Lake client. Every row it renders comes from a registered daemon's API, aggregated fail-soft per daemon.

---

## Features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-001a-hive-process-and-bootstrap`](./prd-001a-hive-process-and-bootstrap.md) | hive's own OS process: Hono daemon, `/health`, single-instance PID/lock, port 3853, `startHive` entrypoint | Draft |
| [`prd-001b-dashboard-migration-and-copy-map`](./prd-001b-dashboard-migration-and-copy-map.md) | The file-by-file copy-map from `honeycomb/src/dashboard/**` into hive, plus honeycomb's retirement + cutover sequencing | Draft |
| [`prd-001c-api-aggregation-wire`](./prd-001c-api-aggregation-wire.md) | hive's server-side BFF proxy: same-origin `wire`, per-daemon routing over doctor's registry, fail-soft aggregation, transparent auth pass-through | Draft |
| [`prd-001d-service-unit-and-registration`](./prd-001d-service-unit-and-registration.md) | hive's OS service unit (launchd/systemd/schtasks) + its idempotent registry entry in doctor's daemon registry | Draft |

---

## Module acceptance criteria

- [ ] hive runs as its own OS process with its own `/health`, PID/lock, and port (3853), independent of honeycomb and nectar (see [`prd-001a`](./prd-001a-hive-process-and-bootstrap.md)).
- [ ] The dashboard shell renders the moment hive's socket binds, before any workload daemon is confirmed healthy; an unanswered daemon renders as "starting," not as a broken page (ADR-0004 decision #1).
- [ ] hive serves the same route registry and pages as the retired honeycomb dashboard, hydrating through the injected `wire` (see [`prd-001b`](./prd-001b-dashboard-migration-and-copy-map.md)).
- [ ] hive holds no Deep Lake client; every dashboard row is fetched from the owning daemon's `/api/*` server-side (the browser is same-origin to hive, which proxies) and aggregated fail-soft per daemon (ADR-0004 decision #2 + ADR-0002; see [`prd-001c`](./prd-001c-api-aggregation-wire.md)).
- [ ] hive ships on its own release train: a dashboard change requires no doctor, honeycomb, or nectar release, and doctor's updates do not force a hive redeploy (ADR-0004 decision #4).
- [ ] honeycomb's `/` dashboard mount and `web/` subtree are retired only after hive is serving, so operators are never dashboard-less (ADR-0001 Decision A + cutover sequencing).
- [ ] hive is supervised by doctor via an idempotent registry entry, installed by hive's own installer with no doctor restart (see [`prd-001d`](./prd-001d-service-unit-and-registration.md)).

---

## Port + path contract (inherited, single source of truth)

hive's port and paths are fixed by nectar's locked contract in [`prd-001b-nectar-process-and-health`](../../../../../nectar/library/requirements/backlog/prd-001-three-daemon-topology/prd-001b-nectar-process-and-health.md). This module cites, does not re-derive.

| Surface | Value | Status |
|---|---|---|
| hive port | `3853` | CONFIRMED (next free after doctor status page 3852; honeycomb 3850, embeddings 3851, nectar 3854) |
| hive PID file | `~/.honeycomb/hive.pid` | DEFAULT, confirm before implementation |
| hive lock file | `~/.honeycomb/hive.lock` | DEFAULT, confirm before implementation |
| hive health | `GET http://127.0.0.1:3853/health` | Derived from port |
| doctor registry | `~/.honeycomb/doctor.daemons.json` | Owned by doctor PRD-004a; hive appends its entry |

---

## Non-Goals

- The doctor daemon registry implementation (config schema, per-daemon supervisor instances). That is doctor's [`prd-004a`](../../../../../nectar/library/requirements/backlog/prd-004-doctor-registry-and-hive/prd-004a-doctor-registry-config-and-supervisor-instances.md) concern; hive consumes it as a given and appends one entry.
- Dashboard **page content** beyond the migrated surface. New pages (for example nectar's Hive Graph page) are their own PRDs; this module delivers the portal process, the migrated dashboard, and the aggregation seam that any new page hydrates through.
- honeycomb's non-web ViewBlock/TUI dashboard layer (`honeycomb/src/dashboard/dashboard.ts` and siblings), which powers the `honeycomb dashboard` CLI and stays in honeycomb.
- Runtime daemon registration. Registration is an install-time file edit (see [`prd-001d`](./prd-001d-service-unit-and-registration.md)).

---

## Related

- [`ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive`](../../../knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md) - the retirement + copy-and-own decision this module implements.
- [`ADR-0002-server-side-bff-proxy-for-dashboard-federation`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) - the server-side proxy federation decision (supersedes client-side federation).
- [`ADR-0003-future-sse-streaming-for-dashboard-freshness`](../../../knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md) - the future SSE freshness direction (polling stays for now).
- [nectar ADR-0003](../../../../../nectar/library/knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md) - the three-daemon topology.
- [nectar ADR-0004](../../../../../nectar/library/knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) - hive's four binding decisions.
- [nectar PRD-004c](../../../../../nectar/library/requirements/backlog/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) - the portal-daemon contract this module adapts.
- [nectar PRD-004d](../../../../../nectar/library/requirements/backlog/prd-004-doctor-registry-and-hive/prd-004d-hive-service-unit-and-registration.md) - the service-unit + registration contract this module adapts.
