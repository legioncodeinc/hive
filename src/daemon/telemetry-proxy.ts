/**
 * The doctor -> hive fleet-telemetry SSE RELAY — hive PRD-004/PRD-005 (sd-AC-6,
 * hr-AC-6, hm-AC-8, lg-AC-1), realizing ADR-0002's server-side BFF proxy for the SSE stream.
 *
 * Mounted at `GET /api/telemetry/stream` (`server.ts`). hive's SERVER connects to doctor's
 * real `GET http://127.0.0.1:3852/events` and re-streams the raw `fleet-telemetry` SSE bytes to
 * the browser same-origin. The browser NEVER opens a connection to doctor's `:3852` directly —
 * this is the one and only seam that does, mirroring `proxy.ts`'s BFF posture for the REST surface.
 *
 * Memory-bounded by construction: this is a straight body-to-body PIPE (`new Response(upstream.body, ...)`),
 * never buffered or accumulated here — the parent index's "never buffer more than the current event"
 * constraint holds trivially because nothing is held in memory between upstream and downstream at all.
 *
 * Fail-soft: doctor unreachable, a non-2xx response, or a non-loopback configured URL all
 * degrade to a 502 with no body, never a thrown error — the browser-side hook (`use-fleet-telemetry.ts`)
 * treats a failed/errored EventSource as "SSE unavailable" and falls back to polling
 * `GET /api/fleet-status`, exactly as it does for a mid-stream drop.
 */

import type { Context } from "hono";

import { DOCTOR_EVENTS_URL } from "../shared/constants.js";
import { isLoopbackBaseUrl } from "../shared/daemon-routing.js";

/**
 * The injectable fetch surface reaching doctor's status page (the global `fetch` in prod, a
 * mock in tests). `redirect` is part of the surface so the relay can pin `redirect: "error"`
 * (matching `proxy.ts`/`fleet-status.ts`): native fetch follows 30x by default, and
 * `isLoopbackBaseUrl()` only validates the FIRST hop, so an unpinned redirect could take the
 * relay off-loopback and defeat the SSRF guard.
 */
export type TelemetryFetch = (
	input: string,
	init?: { readonly signal?: AbortSignal; readonly redirect?: "error" | "follow" | "manual" },
) => Promise<Response>;

/** Options for {@link createTelemetryStreamHandler}. */
export interface CreateTelemetryStreamOptions {
	/** Override doctor's events URL (defaults to the fixed loopback constant). */
	readonly doctorEventsUrl?: string;
	/** The fetch implementation used to reach doctor (defaults to the global `fetch`). */
	readonly fetchImpl?: TelemetryFetch;
}

/** The fail-soft response for an unreachable/misconfigured upstream: an empty 502, no retry-storm body to parse. */
function unreachableStreamResponse(): Response {
	return new Response(null, { status: 502 });
}

/**
 * Build the `GET /api/telemetry/stream` handler. Register it on hive's Hono app BEFORE the
 * generic `/api/*` BFF proxy (`proxy.ts`) so this specific route wins for this one path (Hono
 * composes matching handlers in registration order, same discipline as `/api/fleet-status`).
 *
 * The upstream fetch is tied to the INCOMING request's abort signal, so when the browser closes
 * its EventSource (navigation, unmount, tab close) hive's own connection to doctor closes
 * too — no orphaned upstream sockets accumulate across reconnects.
 */
export function createTelemetryStreamHandler(options: CreateTelemetryStreamOptions = {}) {
	const doctorEventsUrl = options.doctorEventsUrl ?? DOCTOR_EVENTS_URL;
	const fetchImpl = options.fetchImpl ?? (fetch as TelemetryFetch);

	return async (c: Context): Promise<Response> => {
		// Defense in depth (mirrors `proxy.ts`/`fleet-status.ts`): the URL is a fixed constant, never
		// derived from external input, but this re-check ensures a future refactor can never turn
		// this relay into an off-loopback fetch primitive.
		if (!isLoopbackBaseUrl(doctorEventsUrl)) return unreachableStreamResponse();

		try {
			const upstream = await fetchImpl(doctorEventsUrl, { signal: c.req.raw.signal, redirect: "error" });
			if (!upstream.ok || upstream.body === null) return unreachableStreamResponse();

			return new Response(upstream.body, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-store",
					connection: "keep-alive",
				},
			});
		} catch {
			// Network error, refused connection, or an aborted fetch: fail soft, never throw. The
			// browser-side EventSource treats this as a connection failure and retries/falls back.
			return unreachableStreamResponse();
		}
	};
}
