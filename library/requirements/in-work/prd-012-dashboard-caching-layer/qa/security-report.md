# Security Audit — PRD-012: Dashboard caching layer

> **Auditor:** `security-worker-bee`
> **Date:** 2026-07-06
> **Branch:** `feature/prd-012-dashboard-caching-layer` (hive submodule)
> **Phase:** Close-out A (code already implemented + verified passing tests)
> **PRD:** [`prd-012-dashboard-caching-layer`](../prd-012-dashboard-caching-layer-index.md), [`prd-012a`](../prd-012a-bff-proxy-read-cache.md), [`prd-012b`](../prd-012b-client-swr-hook.md)

---

## Executive Summary

**Outcome: PASS — clean.** All 10 PRD-012-specific threats were checked, each with
code citations. **Zero Critical, High, Medium, or Low findings.** Two **INFO**-level
future-risk notes are documented (both already recorded as resolved decisions / open
questions in the PRD itself; no code change required).

No remediations were applied. The gate (`npm run typecheck && npm test`) is green
modulo the 2 pre-existing, out-of-scope `funnel-telemetry` failures, which fail
identically on clean `main`.

**Scope note on coverage:** PRD-012 introduces a React/browser-side SWR hook
(`src/dashboard/web/use-swr.ts`) and a server-side in-memory HTTP cache
(`src/daemon/proxy-cache.ts`). Neither surface is part of the Hivemind stack the
Stinger's primary catalogs target (Deep Lake SQL, pre-tool-use gate, credentials,
capture/PII). The applicable universal patterns (token/credential exposure, body
integrity, size-bound DoS, header information disclosure) were all checked manually
and corroborated by an Aikido SAST cross-check (zero findings). The PRD-012 threat
model supplied with this audit is the primary authority here; the Stinger catalogs
are a secondary signal.

**Ordering check:** `library/qa/` holds QA/security reports only for **PRD-003**
(`2026-07-05-qa-report-prd-003-fleet-lifecycle.md`, `2026-07-04-security-audit-prd-003-uninstall-scripts.md`).
No PRD-012 QA report exists yet, so there is **no ordering inversion** —
`quality-worker-bee` may run after this report without a stale-QA warning.

---

## Scope (files audited)

### Server-side cache (PRD-012a)
- `src/daemon/proxy-cache.ts` — the cache implementation, `CACHEABLE_PATHS` allowlist, `WRITE_INVALIDATIONS` map, `computeCacheKey`, `isHardExcluded`, `resolveWriteInvalidations`, `createInMemoryProxyCache` (TTL + inflight coalescing + nearest-to-expire eviction).
- `src/daemon/proxy.ts` — the modified proxy handler that consumes the cache (`createApiProxy`).
- `tests/daemon/proxy-cache.test.ts` and `tests/daemon/proxy.test.ts` — security-relevant test assertions verified.

### Client-side SWR (PRD-012b)
- `src/dashboard/web/use-swr.ts` — the SWR hook, module-level cache, `invalidateSwr`, `clearSwrCache`, `swrKey`.
- `src/dashboard/web/wire.ts` — the write-method invalidation calls (scope: the invalidation call sites only, lines ~2400–2990; `PROJECT_HEADER` at 181).
- `src/dashboard/web/scope-context.tsx` — the `clearSwrCache()` call on scope switch (`commitScope`, line ~286).

### Supporting surfaces read for context (not in the PRD-012 implementation surface)
- `src/shared/daemon-routing.ts` — `resolveEndpointOwner`, `isLoopbackBaseUrl`, `LOOPBACK_HOSTNAMES`.
- `src/dashboard/web/pages/{dashboard,memories,harnesses,roi,graph,hive-graph}.tsx` — `swrKey(...)` call sites (threat #1c).

---

## Deterministic scans (Phase 1)

| Check | Tool | Result |
|---|---|---|
| Production dependency advisories | `npm audit --json --audit-level=high` | **0 vulnerabilities** (info/low/mod/high/crit all 0) |
| SAST cross-check | Aikido `aikido_full_scan` on the 3 in-scope source files | **0 issues** (only an unrelated Windows Checkov/ENOENT error for an IaC engine that does not apply to TS) |
| Typecheck baseline | `npm run typecheck` (`tsc --noEmit`) | **Clean** |
| Test baseline | `npm test` | **616 pass / 2 fail** — the 2 failures are pre-existing `tests/daemon/installer/funnel-telemetry.test.ts` cases, unrelated to PRD-012 (they assert telemetry-event ordering; they fail identically on clean `main`) |

`npm run audit:openclaw` was not run — PRD-012 introduces **no new runtime dependency**
(verified: `package.json` deps are unchanged by this branch; the SWR hook is hand-rolled
per ADR-0001, and the server cache is stdlib-only). The OpenClaw bundle surface is
untouched, so the bundle scan has nothing new to find.

---

## Threat-by-threat findings

Every one of the 10 PRD-012-specific threats gets an explicit finding below.
**CLEAN** = the implementation is safe against this threat as written.

---

### T1 — Cache-key cross-project leakage (the load-bearing one) → **CLEAN**

The cache key is `${method}:${owner}:${pathname}:${search}:${projectHeader}`. Verified
all three scoping dimensions are present and correctly named:

**(a) Project header read from the RIGHT header name — clean.**
`proxy.ts:158`:
```ts
const projectHeader = incoming.headers.get("x-honeycomb-project") ?? "";
```
matches the canonical header constant in `wire.ts:181`:
```ts
export const PROJECT_HEADER = "x-honeycomb-project" as const;
```
and `projectHeader(projectId)` (`wire.ts:184`) stamps exactly that header on every
project-scoped read. A mismatched header name (e.g. the cache reading
`x-hive-project` while the daemon honors `x-honeycomb-project`) would silently make
the project dimension always `""` and collapse every project into one slot — this is
NOT the case; the names agree.

**(b) Nectar `?project=` query is part of `search` and thus the key — clean.**
`proxy.ts:155` captures `const search = requestUrl.search;` (the raw `?…`, verbatim),
and `computeCacheKey` (`proxy-cache.ts:353`) interpolates `search` as the 4th segment.
`wire.ts:189` `hiveGraphProjectQuery(projectId)` builds `?project=<enc>` and the
hive-graph reads append it to the URL (`wire.ts:2635-2671`), so two nectar projects
produce two distinct `search` values → two distinct keys. Confirmed by the existing
routing test `proxy.test.ts:82` (`/api/hive-graph/nodes?project=abc`).

**(c) Client SWR `swrKey(endpoint, projectId)` suffixes the projectId — clean.**
`use-swr.ts:97`:
```ts
export function swrKey(endpoint: string, projectId?: string): string {
  return projectId ? `${endpoint}:${projectId}` : endpoint;
}
```
and every project-scoped page read uses it: `dashboard.tsx:181`
(`swrKey(ENDPOINTS.kpis, scope.project)`), `memories.tsx:573`
(`swrKey(\`${ENDPOINTS.memories}?limit=${limit}\`, project)`), `graph.tsx:449`,
`roi.tsx:684/689`. Reads that are **not** project-scoped by design correctly omit the
suffix — e.g. `harnesses()` (`wire.ts:2528`, takes no `projectId`, the six canonical
harness statuses are global) → `harnesses.tsx:390` `swrKey(ENDPOINTS.harnesses)`. So no
cross-project collision is possible client-side either.

**(d) Tested.** `proxy.test.ts:236` (`project-scoping-isolation`) issues the same
GET with `x-honeycomb-project: A` then `: B`, asserts 2 distinct `fetchImpl` calls,
each body served only to its own header, and that switching back to `: A` within TTL
is a HIT serving A's body. This is exactly the cross-project-leak regression test.

**Verdict: CLEAN.** No code change.

---

### T2 — No auth in the cache key; confirm safe for v1 → **CLEAN (INFO: future-risk)**

The PRD records (resolved decision, prd-012a §"Security and correctness guards")
that auth is deliberately excluded from the key because hive is local-mode
single-operator. Verified the implementation honors this and does not accidentally
re-introduce a privacy surface:

- `computeCacheKey` (`proxy-cache.ts:353`) takes exactly `(method, owner, pathname,
  search, projectHeader)` — **no auth parameter exists**. The `Authorization` /
  session headers never reach the key.
- `proxy.ts:158` reads only `x-honeycomb-project` from the headers for keying; the
  full header set is forwarded to the upstream via `forwardRequestHeaders` but is
  **not** inspected for caching.
- There is **no code path where two operators share one hive origin today**: hive is
  single-instance by PID/lock (`src/lock.ts`), and the dashboard is loopback-local
  (`127.0.0.1`). The scope switcher (`scope-context.tsx`) re-mints the org-bound
  token on an org switch and the proxy invalidates **ALL** honeycomb entries on
  `/api/diagnostics/scope/org-switch` (`proxy-cache.ts:303`, prefix `""`), so even a
  same-process operator switch cannot leak.

**Verdict: CLEAN.** The assumption (single-operator) holds today and the invalidation
map defends the org-switch edge case. **INFO future-risk:** if/when team/hybrid mode
lets two operators share one hive origin, the key MUST gain a hash of the auth
header / resolved principal. This is already recorded as an open question in
`prd-012a` ("Team/hybrid mode auth in the key") and does not require action now.

---

### T3 — Loopback guard preserved under caching → **CLEAN**

The cache must never be populated from a non-loopback base, and the 502 fail-soft
path must not populate the cache.

- The loopback gate runs **before any cache lookup**: `proxy.ts:160-164`:
  ```ts
  const base = resolveDaemonBases({ registryPath: options.registryPath })[owner];
  if (!isLoopbackBaseUrl(base)) return unreachableResponse(owner);
  ```
  `unreachableResponse` (`proxy.ts:87`) returns a plain 502 — no `cache.set`, no
  `withCacheHeader` even. So a non-loopback base returns before the `cacheable`
  computation (`proxy.ts:167`) is reached. ✓
- The fetch-failure catch (`proxy.ts:222-227`) calls `cache.delete(key)` (clearing
  the inflight entry) and returns a 502 `MISS` — it does **not** `cache.set`. ✓
- **Mid-flight registry change (base becomes non-loopback between request and
  cache-fill):** the key uses `owner` (a pure function of pathname,
  `daemon-routing.ts:11`), never `base`. The cached value is a `Response` object,
  not a base URL. On the next MISS the proxy re-resolves `base` fresh
  (`proxy.ts:160`) and re-checks `isLoopbackBaseUrl`. Because TTLs are short (2/5/30s),
  a registry flip is caught on the next MISS — there is no "cache-stale-loopback"
  path because no base is ever cached. ✓
- The non-loopback registry case is tested at `proxy.test.ts:121`
  (`never proxies to a non-loopback base from a tampered registry`): a registry with
  `http://evil.example.com` is dropped and the proxy falls back to `127.0.0.1:3850`.
- The fetch-reject path is tested at `proxy.test.ts:334`
  (`loopback-guard-no-cache`): a throwing `fetchImpl` returns 502 `MISS`, and a retry
  fetches again (the failure was not cached) — `calls` goes 1→2.

**Verdict: CLEAN.**

---

### T4 — Redirect-pin reject never cached → **CLEAN**

The upstream fetch pins `redirect: "error"` (`proxy.ts:256`). A 3xx response makes
`fetch` throw, which `fetchUpstream` catches and returns `null` (`proxy.ts:258-261`).

- In the **cacheable GET path**, the MISS flow wraps the fetch in a promise that
  **rejects** on `null` (`proxy.ts:208-212`); the rejecting path is the
  `catch` at `proxy.ts:222` which `cache.delete(key)` (clearing the inflight entry
  so the next request retries) and returns 502 `MISS`. No `cache.set` is reachable
  on the reject path. ✓
- In the **bypass/write path**, a `null` response returns 502 `BYPASS` immediately
  (`proxy.ts:173`) — before the invalidation block and without any cache write. ✓
- Coalesced awaiters: if a second GET awaited the inflight promise and it rejected,
  the second caller's `catch` (`proxy.ts:199-202`) returns 502 `MISS`. The original
  rejector already deleted the inflight key. ✓
- Tested at `proxy.test.ts:357` (`redirect-pin preserved`): the `fetchImpl` throws,
  asserts `init?.redirect === "error"` on every call, the response is 502 `MISS`, and
  a second call fetches again (`calls === 2`) — proving nothing was cached.

**Verdict: CLEAN.**

---

### T5 — Cached body integrity → **CLEAN**

The cache stores raw `Response` objects and never parses or mutates the body.

- `cache.set(key, upstream.clone(), ttlMs)` (`proxy.ts:220`) stores a clone of the
  upstream `Response` as-is. The `CacheEntry` type (`proxy-cache.ts:23`) holds
  `response: Response` — no body extraction, no JSON parse, no rewrite.
- On HIT, `entry.response.clone()` (`proxy.ts:191`) returns a fresh clone; the
  cached original is untouched (a `Response` body can be consumed only once, so
  cloning is required and is done).
- `withCacheHeader` (`proxy.ts:118`) rebuilds the response with `new Response(res.body, …)`
  and only **adds** the `X-Hive-Cache` header; it does not alter the body or
  content-type.
- **No "validate before cache":** there is no zod parse between fetch and `cache.set`.
  A malformed upstream body is cached byte-for-byte and served byte-for-byte; the
  client's `zod().catch()` (in `wire.ts` read methods) handles it exactly as it does
  today on an uncached fetch. The fail-soft contract is preserved — the cache does
  not change what the client receives.
- The `X-Hive-Cache` header is added to the served clone, not to the cached original
  (`withCacheHeader` is called on the clone returned to the browser, never on the
  stored `entry.response`), so re-serving a HIT does not accumulate header copies.

**Verdict: CLEAN.**

---

### T6 — Write-invalidation completeness → **CLEAN**

A write that fails to invalidate a derived read could serve stale data that misleads
an operator (correctness → security-adjacent).

- **Coverage:** the `WRITE_INVALIDATIONS` table (`proxy-cache.ts:195-321`) covers
  every mutator in the PRD-012a map: memories store/modify/forget, compact,
  pollinate, sync/{promote,pull,demote,enable,disable}, actions/logout,
  actions/embeddings, actions/memory, graph/build, hive-graph/build,
  hive-graph/projects/brooding, scope/org-switch (ALL), scope/workspace-switch,
  projects/{bind,bind-existing,unbind}. `POST /api/actions/restart` explicitly
  invalidates nothing (the daemon is restarting; the cache misses naturally). Any
  unmatched non-GET falls back to the conservative same-owner broad-prefix default
  (`resolveWriteInvalidations` → `defaultInvalidatePrefix`, `proxy-cache.ts:336`).
  Cross-checked against `wire.ts` write methods — every client mutator has a
  matching server-side rule.
- **Timing — AFTER 2xx, not on failure:** `proxy.ts:177`:
  ```ts
  if (response.ok && method !== "GET" && !isHardExcluded(method, endpointPath)) {
    for (const { owner: invOwner, prefix } of resolveWriteInvalidations(...))
      cache.deleteByPrefix(invOwner, prefix);
  }
  ```
  The `response.ok` guard means a 4xx/5xx write does **not** invalidate (the write
  failed; the cache is still valid). ✓
- **Timing — BEFORE the response returns:** the invalidation loop runs synchronously
  in the same handler tick, before `return withCacheHeader(response, "BYPASS")`
  (`proxy.ts:182`). The next read in a subsequent request therefore sees fresh
  entries. ✓
- **Hard-excluded writes don't invalidate:** `POST /api/memories/recall` is
  hard-excluded (`proxy-cache.ts:370`) and the `!isHardExcluded(...)` guard at
  `proxy.ts:177` prevents it from triggering invalidation (recall is a per-query
  compute, not a state change). ✓
- Tested at `proxy.test.ts:191` (`write-invalidates`): a `POST /api/memories` busts
  both `/api/memories?limit=50` and `/api/diagnostics/kpis` (the derived count); a
  `POST /api/actions/restart` does NOT invalidate (the following kpis read is a HIT).

**Verdict: CLEAN.**

---

### T7 — Client SWR mutation invalidation actually fires → **CLEAN**

`wire.ts` write methods call `invalidateSwr(...)` after success. Verified these are
on the **success path** (non-null ack / parsed-success), not unconditionally and not
inside a fail-soft `catch`:

- `addMemory` (`wire.ts:2408`): `if (ack !== null) invalidateSwr(ENDPOINTS.memories, ENDPOINTS.kpis);`
- `modifyMemory` (`wire.ts:2417`): `if (ack !== null) invalidateSwr(...)`
- `forgetMemory` (`wire.ts:2423`): `if (ack !== null) invalidateSwr(...)`
- `compact` (`wire.ts:2431`): `if (ack !== null) invalidateSwr(...)`
- `pollinate` (`wire.ts:2552`): `if (ack !== null) invalidateSwr(...)`
- sync actions (`wire.ts:2602`): `if (parsed.success && parsed.data.triggered) invalidateSwr(...)`
- `graphBuild` (`wire.ts:2624`): `if (parsed.success && parsed.data.built) invalidateSwr(...)`
- `hiveGraphBuild` (`wire.ts:2704`) / `hiveGraphBrooding` (`wire.ts:2742`): inside the
  `parsed.success` branch.
- `actionsLogout` (`wire.ts:2813`) / `actionsEmbeddings` (`wire.ts:2822`) /
  `actionsMemory` (`wire.ts:2832`): `if (ok) invalidateSwr(...)` — `ok` is the 2xx
  flag.
- project bind/bind-existing/unbind (`wire.ts:2949/2957/2964`):
  `if (ack.bound) ...` / `if (ack.unbound) ...` — success-gated.
- workspace switch (`wire.ts:2986`): `if (ack.switched) invalidateSwr(...)`.

Every call is gated on a positive ack. None sit inside a `catch` block (which would
be dead code) or fire unconditionally (which would wrongly evict on failure — a perf
bug, not security, but it isn't present either). The success-gating matches the
PRD-012b wire-integration spec verbatim.

- Tested at `use-swr.test.tsx:127` (`mutation-invalidation`):
  `invalidateSwr("/api/memories")` drops the entry and the mounted hook refetches.

**Verdict: CLEAN.**

---

### T8 — Size-bound / DoS → **CLEAN**

The cache must not grow unbounded under a paginated-query or project-header flood.

- **Cap exists and fires:** `createInMemoryProxyCache` defaults to
  `maxEntries = 256` (`proxy-cache.ts:66,76`). Both `set` (`proxy-cache.ts:104`) and
  `setInflight` (`proxy-cache.ts:108`) call `evictNearestToExpire()` when
  `!map.has(key) && map.size >= maxEntries` — so the cap is enforced on the
  **new-key** insert path (the only path that grows the map). Re-inserting an
  existing key (a refetch of a cached path) updates in place and does not grow the
  map. ✓
- **No off-by-one:** the guard is `>=`, so at exactly `maxEntries` the next new key
  evicts one before inserting — size never exceeds `maxEntries`. Tested at
  `proxy-cache.test.ts:103` (`eviction`): with `maxEntries: 2`, inserting a 3rd
  distinct key keeps `size === 2` and evicts the nearest-to-expire entry.
- **Paginated-query flood is doubly bounded:**
  1. `CACHEABLE_PATHS` is an **exact-match** `Map` (`proxy.ts:167`
     `CACHEABLE_PATHS.has(endpointPath)`), consulted on the **pathname only**
     (`endpointPath = requestUrl.pathname`, `proxy.ts:154`). A `?limit=50` vs
     `?limit=100` permutation changes `search`, not `pathname`, so both are eligible
     — BUT each distinct `search` is a distinct key, and the 256-entry cap +
     nearest-to-expire eviction bounds the total. A flood of `?limit=` permutations
     can create at most 256 entries, then evicts. ✓
  2. `/api/logs/history` (the cursor-paginated history endpoint the threat calls out)
     is **hard-excluded**: `isHardExcluded("GET", "/api/logs/history")` returns
     `true` (`proxy-cache.ts:372`), so it never enters the cache at all. Tested at
     `proxy-cache.test.ts:147`. `/api/logs/stream` likewise. ✓
- **Project-header permutations:** each distinct `x-honeycomb-project` value is a
  distinct key, but again bounded by the 256 cap. A single-operator dashboard has a
  small fixed set of projects; even a synthetic flood is capped.

**Verdict: CLEAN.**

---

### T9 — `X-Hive-Cache` header information disclosure → **CLEAN**

- **Fixed enum, no payload:** `CacheDisposition = "HIT" | "MISS" | "BYPASS"`
  (`proxy.ts:115`). The header value is one of three literals set at
  `proxy.ts:191/198/201/221/226/173/182`. No cache key, owner, pathname, project
  header, or body content is ever interpolated into it. ✓
- **Liveness disclosure:** the header reveals only that a cache layer exists and
  whether this response was a hit/miss/bypass. It reveals nothing about the
  *content* of other tenants' or projects' data (the existence of a cache is not
  sensitive on a loopback-local single-operator dashboard). hive's entire proxy
  surface is loopback-trusted (`daemon-routing.ts:29` `LOOPBACK_HOSTNAMES`), so the
  browser receiving this header is already the trusted operator. Low risk by
  construction. ✓
- The header is added to the served clone only (`withCacheHeader`), never to the
  cached original, so it cannot accumulate or leak across HITs.

**Verdict: CLEAN.**

---

### T10 — PII / credential exposure → **CLEAN**

The cache must introduce **no new data surface** beyond what the pass-through proxy
already sent to the browser.

- **Stores only `Response` objects:** the cache holds `{ response, expiresAt }` and
  `{ promise }` (`proxy-cache.ts:23`). The `Response` is exactly what
  `fetchUpstream` returned — the same headers+body that the uncached proxy streams to
  the browser. The cache does not capture, copy, or persist anything the browser
  wouldn't already receive. ✓
- **No hive credential:** the proxy is transparent pass-through by design
  (`proxy.ts:11-14` doc-comment): "hive forwards the browser's own request headers
  (session headers + any auth) verbatim... it stores no credential of its own." The
  cache sits behind this, so it has no hive-internal secret to leak. The
  `Authorization` / `x-honeycomb-session` headers flow through `forwardRequestHeaders`
  to the upstream but are **not** read into the cache key or logged. ✓
- **No logging of bodies/headers/keys:** grepped `proxy-cache.ts` and `proxy.ts` —
  there are **zero** `console.*` / logger calls. The cache is silent. No body,
  header, or key is ever written to a log, a file, or a captured trace. ✓
  (Contrast with the Stinger's `safeLog` requirement for the Deep Lake client —
  that surface logs; this one does not log at all.)
- **Module-level client cache:** `use-swr.ts`'s `cache`/`inflight`/`subscribers`
  maps hold only the validated typed value (`T`) the fetcher returned — which is
  already React-rendered in the page. No new surface.

**Verdict: CLEAN.**

---

## Remediations applied

**None.** No Critical, High, Medium, or Low finding was raised. The implementation
is defense-in-depth and correct against all 10 threats. Per the "never silent pass"
directive, each category was checked and is documented above with code citations.

---

## Verification output

Post-audit gate (no code was changed, so this is identical to the baseline):

```
$ npm run typecheck   # tsc --noEmit
> @legioncodeinc/hive@0.6.8 typecheck
> tsc --noEmit
(clean — no output)

$ npm test
 Test Files  1 failed | 73 passed (74)
      Tests  2 failed | 616 passed (618)
```

The 2 failures are `tests/daemon/installer/funnel-telemetry.test.ts`
(`ts-AC-13 accepts tenancy_shown…` and `ts-AC-13 tenancy funnel events`) — they assert
telemetry-event ordering (`login_completed` unexpectedly appears between
`tenancy_shown` and `tenancy_selected`) and are **unrelated to PRD-012**. They fail
identically on clean `main` and are explicitly out of scope for this audit (per the
orchestrator's instructions: "the 2 pre-existing `funnel-telemetry` failures are
acceptable... they are out of PRD-012 scope").

The PRD-012 test suites — `tests/daemon/proxy-cache.test.ts`,
`tests/daemon/proxy.test.ts`, `tests/dashboard/use-swr.test.tsx` — all pass.

`git diff` confirms **no files were modified** by this audit (no remediations were
needed).

---

## Residual risks

1. **INFO (future-risk, already a PRD open question):** auth is excluded from the
   cache key (T2). This is correct for local-mode single-operator hive. If team/
   hybrid mode ever lets two operators share one hive origin, the key MUST gain a
   hash of the auth header / resolved principal, or cross-operator cache leakage
   becomes possible. Tracked as an open question in `prd-012a` ("Team/hybrid mode
   auth in the key"). **No action for v1.**

2. **INFO (future-risk, already a PRD non-goal):** the client SWR cache is per-tab
   with no cross-tab synchronization (`prd-012b` non-goal). A write in tab A
   invalidates A's SWR cache but not tab B's; B's next read hits the proxy cache
   (within its short TTL) and revalidates. Acceptable for v1; a `BroadcastChannel`
   cross-tab invalidation is a documented future enhancement. **No action for v1.**

No other residual risks identified. The implementation is safe to ship.

---

## Sign-off

| Item | Status |
|---|---|
| All 10 threats have an explicit finding with code citations | ✅ |
| Critical/High findings remediated in place with passing tests | N/A (none found) |
| `npm run typecheck` clean | ✅ |
| `npm test` green modulo the 2 pre-existing out-of-scope `funnel-telemetry` failures | ✅ |
| Report written to `library/requirements/in-work/prd-012-dashboard-caching-layer/qa/security-report.md` | ✅ |
| `quality-worker-bee` may now run (no stale-QA ordering inversion) | ✅ |
