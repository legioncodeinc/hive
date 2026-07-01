# ADR-0003, adopt server-sent events for dashboard freshness (future)

> **Status:** Proposed · **Date:** 2026-07-01
> **Supersedes:** none · **Refines:** none (records a future direction for the freshness mechanism established in [`ADR-0002`](./ADR-0002-server-side-bff-proxy-for-dashboard-federation.md))
> **Owners:** platform, thehive
> **Related:** [`ADR-0002`](./ADR-0002-server-side-bff-proxy-for-dashboard-federation.md), [`prd-001c-api-aggregation-wire.md`](../../../requirements/in-work/prd-001-thehive-portal-daemon/prd-001c-api-aggregation-wire.md)

## Context

[`ADR-0002`](./ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) established that thehive federates dashboard data server-side through a proxy, and that data freshness is delivered by **polling**: the copied dashboard pages hydrate on an interval through `usePoll`, each poll a same-origin `GET` that thehive proxies to the owning workload daemon.

Polling was chosen deliberately for the first cut because it is already built (the pages carry `usePoll` from honeycomb), it is dead simple, and it is cheap over loopback with per-source fail-soft that needs no long-lived connection. Its costs are that data is only as fresh as the poll interval (not truly real-time) and that idle panels issue periodic redundant requests (negligible on loopback, but non-zero).

thehive already carries one streaming path: the Logs page tails `/api/logs/stream` via `EventSource`, which the proxy forwards to the owning daemon's SSE endpoint. That proves the proxy can carry a long-lived server-sent-events connection end to end.

This ADR records the intent to generalize that from the log tail to the rest of the dashboard, so the decision and its tradeoffs are captured rather than rediscovered. It is **Proposed**, not Active: no work is scheduled here.

## Decision (proposed)

When real-time freshness is worth the added moving parts, move dashboard data delivery from interval polling to **server-sent events (SSE)** proxied through thehive:

- Each workload daemon exposes an SSE endpoint per live view-model (mirroring honeycomb's existing `/api/logs/stream`).
- The dashboard pages subscribe via `EventSource` to same-origin thehive routes; thehive's proxy forwards the long-lived connection to the owning daemon over loopback (the proxy already streams response bodies, so a `text/event-stream` response is carried through unchanged).
- Reconnect and fail-soft are handled per stream: a dropped or unavailable stream degrades to the last snapshot (and can fall back to a one-shot poll), never a thrown error into React.

SSE is preferred over WebSockets because the dashboard data flow is one-directional (daemon to browser), SSE rides plain HTTP the proxy already forwards, and it reconnects natively; a bidirectional WebSocket would add a protocol the loopback proxy does not otherwise need.

## Consequences (anticipated)

**Positive.**

- Real-time updates without a poll interval; fewer redundant idle requests.
- Reuses the exact path the Logs tail already proves (EventSource through the same-origin proxy).

**Negative.**

- thehive must proxy long-lived connections with explicit reconnect and fail-soft handling for every streamed view, more code and tests than a stateless poll.
- Each workload daemon must grow and maintain an SSE endpoint per live view-model, a wider contract than a plain `GET`.
- More moving parts in the always-on process; a stream that silently stalls is a subtler failure than a poll that simply returns stale-but-fresh-enough data.

## Alternatives considered

- **Stay on polling (current Active state, ADR-0002).** The default until the real-time benefit is demonstrably worth the added surface. Perfectly adequate over loopback for a local dashboard.
- **WebSockets.** Rejected as heavier than needed for one-directional updates; SSE is the lighter fit for the existing HTTP proxy.

## References

- [`ADR-0002`](./ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) - the server-side proxy this would stream over, and the polling baseline it would replace.
- `the-hive/src/dashboard/web/wire.ts` - `logsStream` (the existing `EventSource` tail that proves the SSE-through-proxy path) and the `usePoll`-backed reads this would generalize from.
- `the-hive/src/daemon/proxy.ts` - the proxy that already streams response bodies and would carry the `text/event-stream` connections.
