# Build And Release

> Category: Infrastructure | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

Read this if you build, test, or ship hive: the tsc + esbuild pipeline, the test suite's shape, the OIDC release workflow, and where the npm publish actually stands.

**Related:**
- [../architecture/system-overview.md](../architecture/system-overview.md)
- [../frontend/dashboard-surface.md](../frontend/dashboard-surface.md)
- [../security/trust-boundaries.md](../security/trust-boundaries.md)
- [ADR-0001](../architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md)
---

## The build pipeline

`npm run build` is `tsc && node esbuild.config.mjs`, and the two halves do different jobs:

1. **tsc** compiles the node-side tree (`src/` minus the browser bundle's role) to `dist/` as strict ESM for Node >= 22. The CLI entry is `dist/cli.js` (`bin: { "hive": "dist/cli.js" }`, `main` likewise).
2. **esbuild** does two passes:
   - Bundles the browser SPA from source: entry `src/dashboard/web/main.tsx`, output `dist/daemon/dashboard/app.js`, `platform: "browser"`, `format: "esm"`, `target: es2022`, `jsx: "automatic"`, minified, React + ReactDOM bundled in, `process.env.NODE_ENV` defined to `"production"`. It compiles directly from `.tsx`, not from tsc output, because the web tree is browser code, not part of the node graph.
   - Re-emits exactly one node file in place, `dist/telemetry/emit.js`, substituting the build-time defines `__HONEYCOMB_POSTHOG_KEY__` / `__HONEYCOMB_POSTHOG_HOST__` from CI env vars. An unset key compiles to `""`, which the telemetry chokepoint treats as hard-disabled, so a local or fork build emits nothing. The key is a public write-only ingest key, embedded in the published tarball by design; the CI secret only keeps it out of logs and fork PRs. No real key is ever committed.

Bundle layout after a build:

```
dist/
  cli.js                       # the bin entry (start | install-service | uninstall-service | register)
  cli-commands.js, lock.js, errors.js
  daemon/                      # server, gate, proxy, registry, fleet-status, setup-auth, telemetry-proxy
  daemon/dashboard/            # host.js, web-assets.js, app.js (the browser bundle)
  dashboard/                   # contracts + the tsc-compiled web tree (type surface; the browser runs app.js)
  install/registry.js
  service/                     # platform, templates, commands, index
  shared/                      # constants, daemon-routing, fleet-readiness, fleet-telemetry, service-status, ...
  telemetry/emit.js            # the define-stamped chokepoint
```

The published tarball is the `files: ["dist"]` allowlist plus package.json/README/LICENSE. The repo `assets/` tree (tokens CSS, logo, fonts) rides with the repo layout; `web-assets.ts` resolves it by walking up from the compiled module and fails soft (404, never 500) on a stripped install. Runtime deps are deliberately tiny: `hono`, `@hono/node-server`, `react`, `react-dom`, `zod`.

## The test suite

`npm test` is `vitest run`: 33 test files, roughly 225 test cases, mirroring `src/` by domain.

| Area | Files | What they pin |
|---|---|---|
| `tests/daemon/` | server, gate, proxy, fleet-status, telemetry-proxy | Route table order, gate precedence + exemptions + fail-closed auth, header hygiene + fail-soft 502, loopback/redirect pins, SSE relay |
| `tests/dashboard/` | host, registry, router, boot-route, copy-map, buzzing-screen, health-rail, health-page, login-screen, service-icons, use-fleet-telemetry (x2), hive-graph (x3) | Shell + asset serving, the 36-file copy-map count, path routing, the readiness/health surfaces (jsdom + testing-library) |
| `tests/wire/` | federation, registry, fail-soft, registered-service-names | Endpoint ownership, registry parsing + defaults, zod empty-state degradation |
| `tests/service/` + `tests/install/` | platform, templates, commands, service-module, registry | Per-OS unit rendering, legacy `thehive` migration, idempotent atomic registry upsert |
| `tests/` root + `tests/shared/` + `tests/telemetry/` | lock, cli-commands, fleet-telemetry, service-status, emit | PID lock + stale reclaim, verb exit codes, wire-shape parsing, the five-state derivation, telemetry gates |

`vitest.config.ts` keeps the node environment default with jsdom where a suite declares it. There is no ESLint/Prettier layer; the gate is `npm run typecheck` (tsc strict `--noEmit`) plus the suite.

## CI (`.github/workflows/ci.yaml`)

Every push and PR to main runs the same recipe a developer runs locally, on a three-OS matrix (ubuntu, macos, windows): `npm ci`, typecheck, test, build, then `npm pack --dry-run` as packaging sanity. The matrix spends its axes on OS rather than Node majors because the per-OS service-unit and path/argv logic (`src/service/`) is the thing a single-OS leg cannot exercise. Explicitly out of CI scope: actually installing OS services, surviving reboots, or supervisor-driven restarts; those need a privileged host. Least-privilege posture throughout: `permissions: contents: read`, `persist-credentials: false`, concurrency-cancel on superseded refs.

This CI plus `release.yaml` is what closed PRD-001's one open acceptance criterion (m-AC-5, the independent release train), which the QA report had correctly left open when no automation existed.

## Release (`.github/workflows/release.yaml`)

The release workflow mirrors honeycomb's and doctor's OIDC Trusted Publishing pattern exactly, adjusted only for hive's real scripts (discrete `typecheck` + `test` steps instead of an aggregate `npm run ci` hive does not have).

- **Triggers**: a pushed `vX.Y.Z` tag attempts a real publish; `workflow_dispatch` rehearses with `npm publish --dry-run` and defaults `dry_run` to true, so the manual button is safe by default.
- **Auth is tokenless.** No `NPM_TOKEN` exists anywhere. GitHub Actions presents a short-lived OIDC identity (`id-token: write`) that npm verifies against the trusted publisher configured on the package (org + repo `hive` + the workflow filename). The job upgrades npm to 11.6.2 first (Trusted Publishing needs >= 11.5.1; Node 22 ships 10.x) and strips setup-node's scaffolded dummy `_authToken` so npm actually takes the OIDC path. Provenance stays on: `npm publish --provenance --access public`, signed by the same OIDC identity.
- **Fails closed.** A tag/package.json version mismatch aborts; the `0.0.0` sentinel aborts; a package name other than `@legioncodeinc/hive` aborts. An idempotency check against the registry lets a rerun after a partial failure skip straight to the GitHub Release instead of dying on a republish.
- **Telemetry defines** ride both the gate build and the publish steps, because `prepack` (`npm run build`) reruns inside `npm publish` and the rebuilt tarball must be keyed too.

## Local development workflow

The whole loop, no hidden steps:

```bash
npm ci                 # install from the committed lockfile (Node >= 22 required by engines)
npm run typecheck      # tsc --noEmit, the strict gate
npm test               # vitest run (node env; jsdom suites declare themselves)
npm run build          # tsc + esbuild: node dist + browser bundle + telemetry stamp
npm start              # node dist/cli.js start, binds 127.0.0.1:3853
npm pack --dry-run     # packaging sanity, same as CI's last step
```

A source build of hive alone gets you the shell, `/buzzing`, and fleet status; the full dashboard lights up when honeycomb (and doctor) are running, because every data panel hydrates through the BFF proxy. There is no watch mode wired into the scripts; rebuild after web-tree changes (the shell serves `app.js` with `no-cache`, so a rebuild is picked up on the next browser load without cache tricks).

## Cutting a release

1. Bump the version: `npm version <x.y.z>` (updates package.json and tags locally, or bump manually and tag `v<x.y.z>`).
2. Update the superproject's `hive-release.json` pin for hive to the same version.
3. Push the tag. The workflow gates (typecheck, test, tag/version guard, publishability preflight), builds keyed, publishes via OIDC, and creates the GitHub Release with generated notes.
4. Rehearse first if in doubt: run the workflow manually; `dry_run` defaults to true and exercises everything through `npm publish --dry-run`.

The tag/version guard means a mismatched tag dies in CI, not on the registry; the idempotency check means a rerun of a partially failed release is safe.

## Where the publish actually stands

`@legioncodeinc/hive` is version `0.1.0` and `published: false` in the superproject's `hive-release.json` manifest (alongside doctor `0.1.10` published: false and nectar `0.0.1` published: false; honeycomb `0.1.13` is the only published product today). The blocker is the documented one-time bootstrap: npm's trusted-publisher configuration requires the package to already exist on the registry, so the first publish is necessarily a manual 2FA `npm publish`, after which the trusted publisher is registered and every subsequent tag push publishes tokenless. Until that human step happens, a real tag push will fail the OIDC handshake, and that failure is expected. The `publishConfig` in package.json (`access: public`, `provenance: true`) is already in place for that day.
