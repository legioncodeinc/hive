/**
 * PRD-011a tenancy wire client: same-origin `/setup/tenancy/*` via hive's BFF proxy (no onboarding
 * token). Mirrors `onboarding-client.ts` fail-soft discipline; lives beside it in the onboarding folder.
 *
 * Client robustness (operator-reported incident): a stalled `/setup/tenancy*` request used to leave
 * the tenancy step's `await` pending forever, an infinite spinner with no way out ("Back to
 * organizations" never returning). Every call below is now bounded by
 * {@link TENANCY_REQUEST_TIMEOUT_MS} via `AbortController` (generous for a slow gateway, never
 * unbounded), and still fails SOFT (never throws into React): a timeout, a network error, a
 * non-2xx status, or a malformed body all degrade to the same typed default the caller already
 * expects, but MARKED via {@link isTenancyRequestFailure} so the step can tell a genuine empty or
 * unselected read apart from a failed one and render an honest, retryable state rather than a
 * misleading "nothing here" message.
 */

import {
	EMPTY_TENANCY_ORGS,
	EMPTY_TENANCY_WORKSPACES,
	SetupTenancySchema,
	TenancyCreateResponseSchema,
	TenancyOrgsSchema,
	TenancySelectResponseSchema,
	TenancyWorkspacesSchema,
	UNSELECTED_SETUP_TENANCY,
	type SetupTenancyWire,
	type TenancyCreateResponseWire,
	type TenancyOrgsWire,
	type TenancySelectResponseWire,
	type TenancyWorkspacesWire,
} from "./tenancy-contracts.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TenancyClientOptions {
	readonly origin?: string;
	readonly fetchImpl?: FetchLike;
}

export interface TenancyClient {
	setupTenancy(): Promise<SetupTenancyWire>;
	listOrgs(): Promise<TenancyOrgsWire>;
	listWorkspaces(orgId: string): Promise<TenancyWorkspacesWire>;
	selectTenancy(orgId: string, workspaceId: string): Promise<TenancySelectResponseWire | null>;
	createWorkspace(org: string, name: string): Promise<TenancyCreateResponseWire | null>;
}

/**
 * The generous client-side bound (ms) for every `/setup/tenancy*` call. A slow gateway is normal
 * and must not abort a legitimate in-flight read; a genuinely hung request is not, and must never
 * leave the tenancy step's loading state spinning forever.
 */
export const TENANCY_REQUEST_TIMEOUT_MS = 15_000 as const;

const REQUEST_FAILURE_MARKER: unique symbol = Symbol("tenancyRequestFailure");

/**
 * Stamp a FRESH copy of a fail-soft default with the failure marker (never mutates a shared
 * singleton like {@link EMPTY_TENANCY_ORGS}: that object is reused across genuinely-empty reads,
 * so mutating it in place would falsely mark every future empty read as failed too).
 */
function markRequestFailed<T extends object>(value: T): T {
	return Object.defineProperty({ ...value }, REQUEST_FAILURE_MARKER, { value: true, enumerable: false }) as T;
}

/**
 * True iff `value` was returned via {@link markRequestFailed}: a timeout, network error, non-2xx
 * status, or malformed body, never a genuine read. Callers use this to render an honest, retryable
 * failure state instead of treating the fail-soft default (e.g. zero orgs) as the real answer.
 */
export function isTenancyRequestFailure(value: unknown): boolean {
	return typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[REQUEST_FAILURE_MARKER] === true;
}

export function createTenancyClient(options: TenancyClientOptions = {}): TenancyClient {
	const origin = options.origin ?? "";
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = (path: string): string => `${origin}${path}`;

	return {
		async setupTenancy(): Promise<SetupTenancyWire> {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), TENANCY_REQUEST_TIMEOUT_MS);
			try {
				const res = await fetchImpl(url("/setup/tenancy"), { headers: { accept: "application/json" }, signal: ac.signal });
				if (!res.ok) return markRequestFailed(UNSELECTED_SETUP_TENANCY);
				const parsed = SetupTenancySchema.safeParse(await res.json());
				return parsed.success ? parsed.data : markRequestFailed(UNSELECTED_SETUP_TENANCY);
			} catch {
				// A timeout/abort, network error, or non-JSON body all degrade to the same fail-soft
				// default, marked so the caller can tell this apart from an honest "not selected" read.
				return markRequestFailed(UNSELECTED_SETUP_TENANCY);
			} finally {
				clearTimeout(timer);
			}
		},

		async listOrgs(): Promise<TenancyOrgsWire> {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), TENANCY_REQUEST_TIMEOUT_MS);
			try {
				const res = await fetchImpl(url("/setup/tenancy/orgs"), { headers: { accept: "application/json" }, signal: ac.signal });
				if (!res.ok) return markRequestFailed(EMPTY_TENANCY_ORGS);
				const parsed = TenancyOrgsSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : markRequestFailed(EMPTY_TENANCY_ORGS);
			} catch {
				return markRequestFailed(EMPTY_TENANCY_ORGS);
			} finally {
				clearTimeout(timer);
			}
		},

		async listWorkspaces(orgId: string): Promise<TenancyWorkspacesWire> {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), TENANCY_REQUEST_TIMEOUT_MS);
			const fallback = { ...EMPTY_TENANCY_WORKSPACES, org: orgId };
			try {
				const qs = `?org=${encodeURIComponent(orgId)}`;
				const res = await fetchImpl(url(`/setup/tenancy/workspaces${qs}`), {
					headers: { accept: "application/json" },
					signal: ac.signal,
				});
				if (!res.ok) return markRequestFailed(fallback);
				const parsed = TenancyWorkspacesSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : markRequestFailed(fallback);
			} catch {
				return markRequestFailed(fallback);
			} finally {
				clearTimeout(timer);
			}
		},

		async selectTenancy(orgId: string, workspaceId: string): Promise<TenancySelectResponseWire | null> {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), TENANCY_REQUEST_TIMEOUT_MS);
			try {
				const res = await fetchImpl(url("/setup/tenancy/select"), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ orgId, workspaceId }),
					signal: ac.signal,
				});
				if (!res.ok) return null;
				const parsed = TenancySelectResponseSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : null;
			} catch {
				// A timeout/abort or network error is indistinguishable from any other soft failure
				// here: `null` is already the client's typed "could not confirm" signal (the step
				// renders "Selection could not be saved. Retry." and re-issues the same request).
				return null;
			} finally {
				clearTimeout(timer);
			}
		},

		async createWorkspace(org: string, name: string): Promise<TenancyCreateResponseWire | null> {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), TENANCY_REQUEST_TIMEOUT_MS);
			try {
				const res = await fetchImpl(url("/setup/tenancy/workspaces"), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ org, name }),
					signal: ac.signal,
				});
				if (!res.ok) return null;
				const parsed = TenancyCreateResponseSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : null;
			} catch {
				return null;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
