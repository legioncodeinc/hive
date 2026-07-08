/**
 * The `/onboarding` route's WIRE CLIENT, PRD-009b, talking to the PRD-009a installer service.
 * Mirrors `wire.ts`'s fetch+zod discipline (fail-soft, never throws into React) but is kept
 * LOCAL to the onboarding feature folder per the file-ownership split with the daemon-side agent
 * building `src/daemon/installer/**` in parallel.
 *
 * Every call carries the one-time onboarding token as the `x-onboarding-token` header (the PRD's
 * "carried on every installer call"), EXCEPT the SSE subscription: `EventSource` cannot set request
 * headers, so the token rides as a `?t=` query param there instead (the implementation note both
 * the parent brief and PRD-009a's SSE contract call for).
 */

import { z } from "zod";

import {
	DetectResponseSchema,
	EMPTY_DETECTION,
	InstallProgressEventSchema,
	InstallRefusalResponseSchema,
	InstallStartResponseSchema,
	parseHealthResponse,
	UNREACHABLE_HEALTH,
	type DetectResponse,
	type HealthResponse,
	type InstallableProduct,
	type InstallProgressEvent,
	type InstallRefusalResponse,
	type InstallStartResponse,
	type InstallStartResult,
} from "./contracts.js";

/** The header carrying the one-time onboarding token on every installer call (never the SSE query). */
export const ONBOARDING_TOKEN_HEADER = "x-onboarding-token" as const;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/harness/connect (PRD-006c) — the "Connect your coding assistant" trigger.
// LOCAL types matching honeycomb's `ConnectSeamResult` field names exactly (the same local-contract
// discipline the rest of this file uses): a later integration pass can point imports at a shared
// module without renaming a field.
// ─────────────────────────────────────────────────────────────────────────────

/** The default harness the connect trigger targets (matches honeycomb's default). */
const DEFAULT_HARNESS = "claude-code";

/** The renderable connect statuses hive shows for the harness (mirrors honeycomb's `ConnectStatus`). */
export const HARNESS_CONNECT_STATUSES = ["connected", "agent-absent", "cli-absent", "error"] as const;
export type HarnessConnectStatus = (typeof HARNESS_CONNECT_STATUSES)[number];

const HarnessConnectResultSchema = z.object({
	harness: z.string().catch(DEFAULT_HARNESS),
	status: z.enum(HARNESS_CONNECT_STATUSES).catch("error"),
	detail: z.string().optional(),
});
export type HarnessConnectResult = z.infer<typeof HarnessConnectResultSchema>;

/**
 * The honest fail-soft default when hive is unreachable / the body is malformed: an `error` status
 * (the step offers a generic Retry). A genuine `cli-absent`/`agent-absent` comes from a SUCCESSFUL
 * read of the honeycomb CLI's own status, never fabricated here.
 */
const HARNESS_CONNECT_FAILED: HarnessConnectResult = Object.freeze({ harness: DEFAULT_HARNESS, status: "error" });

/** A fetch-like function, injectable so tests never hit the network (mirrors `wire.ts`'s `FetchLike`). */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** An `EventSource`-constructor-like injectable, so tests never open a real connection. */
type EventSourceCtorLike = new (url: string | URL) => EventSource;

export interface OnboardingClientOptions {
	/** Prefixed onto every request path (defaults to same-origin, `""`). A test injects a base. */
	readonly origin?: string;
	/** Defaults to the global `fetch`; a test injects a mock. */
	readonly fetchImpl?: FetchLike;
	/** Defaults to the global `EventSource`; a test injects a fake (jsdom has none, see module doc below). */
	readonly eventSourceCtor?: EventSourceCtorLike;
}

/** The onboarding wire surface every onboarding component reads/writes through. */
export interface OnboardingClient {
	/** `GET /api/onboarding/detect`, never assumes a product set; a failure degrades to {@link EMPTY_DETECTION}. */
	detect(): Promise<DetectResponse>;
	/** `POST /api/onboarding/install`, starts (or short-circuits) one product's install. `null` on failure. */
	startInstall(product: InstallableProduct): Promise<InstallStartResult | null>;
	/**
	 * `GET /api/onboarding/install/:product/events` (SSE). Returns an unsubscribe function. In an
	 * `EventSource`-less environment (jsdom, mirroring `use-fleet-telemetry.ts`'s documented gap)
	 * this is a no-op subscription, the caller's install-card falls back to its optimistic local
	 * stage tracking rather than throwing.
	 */
	subscribeInstallEvents(product: InstallableProduct, onEvent: (event: InstallProgressEvent) => void): () => void;
	/** `GET /api/onboarding/health`, a failure degrades to {@link UNREACHABLE_HEALTH} (never `ready:true`). */
	health(): Promise<HealthResponse>;
	/** `POST /api/onboarding/complete` (204). Best-effort: never throws, never blocks the caller's navigation. */
	complete(): Promise<void>;
	/**
	 * `POST /api/onboarding/harness/connect` (PRD-006c c-AC-1). Shells the honeycomb harness reconcile
	 * and returns the renderable connect status. Fail-soft: a hive/CLI failure degrades to `error`
	 * (the step offers Retry), never a throw, so onboarding never hangs or dead-ends (c-AC-5). Retry
	 * is the caller invoking this again after installing the agent (c-AC-3).
	 */
	connectHarness(): Promise<HarnessConnectResult>;
	/**
	 * `POST /api/onboarding/event` (202), the UI funnel chokepoint. FIRE-AND-FORGET by design: the
	 * caller never awaits this (a slow/broken telemetry endpoint must never stall the guided flow).
	 */
	sendEvent(event: string, properties?: Record<string, string>): void;
}

function tokenHeaders(token: string): Record<string, string> {
	return token !== "" ? { [ONBOARDING_TOKEN_HEADER]: token } : {};
}

/** Build the onboarding wire client bound to one onboarding token (read once from `?t=`, kept in memory). */
export function createOnboardingClient(token: string, options: OnboardingClientOptions = {}): OnboardingClient {
	const origin = options.origin ?? "";
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = (path: string): string => `${origin}${path}`;

	return {
		async detect(): Promise<DetectResponse> {
			try {
				const res = await fetchImpl(url("/api/onboarding/detect"), {
					headers: { accept: "application/json", ...tokenHeaders(token) },
				});
				if (!res.ok) return EMPTY_DETECTION;
				const parsed = DetectResponseSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : EMPTY_DETECTION;
			} catch {
				return EMPTY_DETECTION;
			}
		},

		async startInstall(product: InstallableProduct): Promise<InstallStartResult | null> {
			try {
				const res = await fetchImpl(url("/api/onboarding/install"), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json", ...tokenHeaders(token) },
					body: JSON.stringify({ product }),
				});
				if (res.status === 409) {
					const parsed = InstallRefusalResponseSchema.safeParse(await res.json());
					return parsed.success ? parsed.data : null;
				}
				if (!res.ok) return null;
				const parsed = InstallStartResponseSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : null;
			} catch {
				return null;
			}
		},

		subscribeInstallEvents(product: InstallableProduct, onEvent: (event: InstallProgressEvent) => void): () => void {
			const EventSourceCtor =
				options.eventSourceCtor ?? (globalThis as { EventSource?: EventSourceCtorLike }).EventSource;
			if (EventSourceCtor === undefined) {
				// jsdom (this repo's test environment) has no EventSource, mirroring the exact gap
				// `use-fleet-telemetry.ts` documents. Tests inject a fake constructor to exercise this path.
				return () => {};
			}

			const qs = token !== "" ? `?t=${encodeURIComponent(token)}` : "";
			let source: EventSource | null = null;
			try {
				source = new EventSourceCtor(url(`/api/onboarding/install/${encodeURIComponent(product)}/events${qs}`));
			} catch {
				return () => {};
			}

			// The contract names no custom SSE event type, so this subscribes to the default unnamed
			// `message` frame (see the onboarding-client research note in the final report: if the
			// daemon's implementation ends up naming the event, this is a one-line integration fix).
			const handler = (event: MessageEvent): void => {
				const raw = typeof event.data === "string" ? event.data : String(event.data);
				try {
					const parsed = InstallProgressEventSchema.safeParse(JSON.parse(raw));
					if (parsed.success) onEvent(parsed.data);
				} catch {
					// A malformed frame is dropped; the next frame (or the server's on-subscribe
					// current-stage resend, ob-AC-17) carries the truth forward.
				}
			};
			source.addEventListener("message", handler as EventListener);

			return () => {
				try {
					source?.removeEventListener("message", handler as EventListener);
					source?.close();
				} catch {
					// Closing an already-closed/errored source must never throw into the caller's cleanup.
				}
			};
		},

		async health(): Promise<HealthResponse> {
			try {
				const res = await fetchImpl(url("/api/onboarding/health"), {
					headers: { accept: "application/json", ...tokenHeaders(token) },
				});
				if (!res.ok) return UNREACHABLE_HEALTH;
				return parseHealthResponse(await res.json());
			} catch {
				return UNREACHABLE_HEALTH;
			}
		},

		async complete(): Promise<void> {
			try {
				await fetchImpl(url("/api/onboarding/complete"), { method: "POST", headers: tokenHeaders(token) });
			} catch {
				// Best-effort: the login step navigates to the dashboard regardless (never gets the
				// operator stuck because a completion beacon failed to land).
			}
		},

		async connectHarness(): Promise<HarnessConnectResult> {
			try {
				const res = await fetchImpl(url("/api/onboarding/harness/connect"), {
					method: "POST",
					headers: { accept: "application/json", ...tokenHeaders(token) },
				});
				if (!res.ok) return HARNESS_CONNECT_FAILED;
				const parsed = HarnessConnectResultSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : HARNESS_CONNECT_FAILED;
			} catch {
				// A network error / abort / non-JSON body degrades to the honest `error` default so the
				// step offers Retry rather than fabricating a connected/absent state (c-AC-5).
				return HARNESS_CONNECT_FAILED;
			}
		},

		sendEvent(event: string, properties?: Record<string, string>): void {
			const body = properties !== undefined ? { event, properties } : { event };
			// Fire-and-forget: the caller never awaits this, so a slow/broken telemetry endpoint can
			// never stall the guided flow. Swallow every failure silently (fail-soft telemetry posture).
			void fetchImpl(url("/api/onboarding/event"), {
				method: "POST",
				headers: { "content-type": "application/json", ...tokenHeaders(token) },
				body: JSON.stringify(body),
			}).catch(() => {});
		},
	};
}
