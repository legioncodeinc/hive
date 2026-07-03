---
ai_description: |
  This folder contains internal engineering and business documentation.
  ADRs MUST live in architecture/ADR-<n>-<kebab-slug>.md.
  Engineering standards MUST live in standards/documentation-framework.md.
  Other domain folders (<domain>/) are repo-specific and may be created as
  needed (ai/, auth/, data/, frontend/, infrastructure/, integrations/,
  marketing/, operations/, personas/, reporting/, roadmap/, scanners/,
  security/, strategy/, etc.).
  Do NOT file customer-facing content here (that goes in knowledge/public/).
  Write path: library/knowledge/private/<domain>/<kebab-slug>.md.
human_description: |
  Internal engineering and business documentation.
  - architecture/: Architecture Decision Records (ADRs)
  - standards/: Documentation framework and coding standards
  - <domain>/: Any repo-specific knowledge domain (ai/, auth/, data/, etc.)
  Default landing zone for any doc that does not need to be customer-facing.
  When creating a new domain folder, add a README.md explaining what belongs.
---

# Knowledge — Private

Internal documentation for engineers, product, and AI agents.

## Document index

### architecture/

| Doc | What it covers |
|---|---|
| [system-overview.md](architecture/system-overview.md) | Why hive exists (velocity/stability split), fleet position, boot-to-dashboard lifecycle, provenance |
| [copy-and-own-provenance.md](architecture/copy-and-own-provenance.md) | The ADR-0001 story: honeycomb-to-hive file mapping, what was retired, the divergence policy |
| [bff-proxy-federation.md](architecture/bff-proxy-federation.md) | The server-side BFF proxy: target resolution, auth pass-through, fail-soft aggregation, no CORS on workloads |
| [landing-gate-and-routing.md](architecture/landing-gate-and-routing.md) | The health-first-auth-second gate, the exact route table, `/buzzing` `/login` `/health` semantics |
| [shared-contracts-and-routing.md](architecture/shared-contracts-and-routing.md) | The `src/shared/` contract layer: routing rule, loopback trust, constants, fleet readiness, service status, Contract C |
| [doctor-registration-and-lifecycle.md](architecture/doctor-registration-and-lifecycle.md) | Single-instance lock, OS service units (`com.legioncode.hive`), idempotent doctor registration, uninstall gaps |
| [ADR-0001](architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md) | Retire honeycomb's dashboard; copy-and-own into hive |
| [ADR-0002](architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) | Server-side BFF proxy for dashboard federation |
| [ADR-0003](architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md) | SSE for dashboard freshness (Proposed; realized for health by ADR-0004) |
| [ADR-0004](architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) | Portal landing gate and path-based routing |

### frontend/

| Doc | What it covers |
|---|---|
| [dashboard-surface.md](frontend/dashboard-surface.md) | Page inventory, asset build/serve, data flow through the BFF, theming, diffs from honeycomb's original |
| [spa-architecture.md](frontend/spa-architecture.md) | The SPA shell end to end: boot-route, registry, path router, frame primitives, scope context, adding a page |
| [wire-and-data-fetch.md](frontend/wire-and-data-fetch.md) | `wire.ts`: the ENDPOINTS list, the WireClient surface, zod fail-soft, scope/session headers, adding an endpoint |
| [pages-inventory-deep-dive.md](frontend/pages-inventory-deep-dive.md) | Every registry page and shared empty-state: data source, states, notable components |
| [hive-graph-and-graph-pages.md](frontend/hive-graph-and-graph-pages.md) | The `/graph` and `/hive-graph` pages, the shared `layout` engine, and the nectar projection transform |
| [fleet-telemetry-client.md](frontend/fleet-telemetry-client.md) | `useFleetTelemetry`: SSE-first/REST-fallback, pure transitions, the bounded ring buffer |
| [buzzing-and-health-rail.md](frontend/buzzing-and-health-rail.md) | The `/buzzing` loaders, bee state model, health rail, `/health` page, and the doctor SSE pipeline |
| [portal-readiness-splash.md](frontend/portal-readiness-splash.md) | The pinned product note behind the readiness work (Option B: doctor as the single health source) |

### integrations/

| Doc | What it covers |
|---|---|
| [workload-endpoint-inventory.md](integrations/workload-endpoint-inventory.md) | Every honeycomb/nectar/doctor endpoint hive consumes, their shapes, and the auth pass-through |

### operations/

| Doc | What it covers |
|---|---|
| [cli-and-runbook.md](operations/cli-and-runbook.md) | The four CLI verbs, argv, exit codes, env vars, and the day-to-day operator runbook |
| [on-disk-footprint.md](operations/on-disk-footprint.md) | Every file hive reads/writes: lock, pid, doctor registry entry, telemetry ledger, service units |

### telemetry/

| Doc | What it covers |
|---|---|
| [telemetry-egress.md](telemetry/telemetry-egress.md) | The single egress chokepoint, the four events, the property allow-list, opt-outs, and the dedupe ledger |

### security/

| Doc | What it covers |
|---|---|
| [trust-boundaries.md](security/trust-boundaries.md) | Loopback binding, the proxy as the auth chokepoint, SSRF layers, gate hardening, known gaps |

### infrastructure/

| Doc | What it covers |
|---|---|
| [build-and-release.md](infrastructure/build-and-release.md) | tsc + esbuild pipeline, test suite shape, CI matrix, OIDC release, npm publish status |
| [release-train-and-manifest.md](infrastructure/release-train-and-manifest.md) | Hive's place in the superproject `hive-release.json` combined release train, `published:false`, the bootstrap |

### standards/

| Doc | What it covers |
|---|---|
| [documentation-framework.md](standards/documentation-framework.md) | The writing rules every doc in this tree follows |

## Required sub-folders (always present)

| Folder | Contents |
|---|---|
| `architecture/` | ADRs: `ADR-<n>-<kebab-slug>.md`. Locked decisions with context, alternatives, consequences. |
| `standards/` | `documentation-framework.md` and any repo-specific writing rules. |

## Optional domain folders

Create any of these as needed: `ai/`, `auth/`, `data/`, `frontend/`, `infrastructure/`, `integrations/`, `marketing/`, `operations/`, `personas/`, `reporting/`, `roadmap/`, `scanners/`, `security/`, `strategy/`, `reference/`, `<product>-ux-ui/`.

## What does NOT belong here

- Customer-facing content (put in `knowledge/public/`)
- PRDs or IRDs (put in `requirements/` or `issues/`)
- Brand assets (put in `legion-shared/brands/`)
