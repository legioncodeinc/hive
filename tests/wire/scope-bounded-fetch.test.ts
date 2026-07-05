/**
 * hive IRD-122 follow-up: the "switch freeze" fix's WIRE-LAYER bound: `scopeOrgs`,
 * `scopeWorkspaces`, `scopeProjects`, `switchOrg`, `switchWorkspace`, and `setupTenancy` are the
 * calls the org/workspace switcher chains, and each one is now bounded by `SCOPE_REQUEST_TIMEOUT_MS`
 * via `AbortController` rather than the previously-unbounded `getJson`/`postJson`. A single stalled
 * gateway hop used to leave the switcher's `loadingWorkspaces`/`switchFeedback.pending` open forever;
 * these tests prove each bounded call always SETTLES (to its honest fail-soft default) once the
 * timeout elapses, and never settles EARLY on a merely-slow-but-live call.
 */

import {
	createWireClient,
	FAILED_ORG_SWITCH_ACK,
	FAILED_WORKSPACE_SWITCH_ACK,
	SCOPE_REQUEST_TIMEOUT_MS,
	UNREACHABLE_SETUP_TENANCY,
	type FetchLike,
} from "../../src/dashboard/web/wire.js";

/** A `fetch` stand-in that never settles unless its request is aborted (simulates a hung gateway hop). */
function hangingFetch(): FetchLike {
	return ((_input: Parameters<FetchLike>[0], init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => {
				reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			});
		})) as unknown as FetchLike;
}

/** A `fetch` stand-in that settles after `ms` (a slow-but-LIVE gateway hop) with a 200 JSON body. */
function delayedFetch(ms: number, body: unknown): FetchLike {
	return ((_input: Parameters<FetchLike>[0], init?: RequestInit) =>
		new Promise<Response>((resolve, reject) => {
			const timer = setTimeout(
				() => resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })),
				ms,
			);
			init?.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			});
		})) as unknown as FetchLike;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("scope/tenancy bounded-fetch: never hangs past SCOPE_REQUEST_TIMEOUT_MS", () => {
	it("scopeOrgs() degrades to [] on a stalled gateway hop, not before the bound and not after it either", async () => {
		const wire = createWireClient({ fetchImpl: hangingFetch() });
		let settled = false;
		const promise = wire.scopeOrgs().then((v) => {
			settled = true;
			return v;
		});

		await vi.advanceTimersByTimeAsync(SCOPE_REQUEST_TIMEOUT_MS - 1000);
		expect(settled).toBe(false); // not aborted early: a slow-but-live call must not be cut short prematurely.

		await vi.advanceTimersByTimeAsync(2000);
		await expect(promise).resolves.toEqual([]);
	});

	it("scopeWorkspaces() degrades to an empty workspace list on timeout, never a hang", async () => {
		const wire = createWireClient({ fetchImpl: hangingFetch() });
		const promise = wire.scopeWorkspaces("acme");
		await vi.advanceTimersByTimeAsync(SCOPE_REQUEST_TIMEOUT_MS + 500);
		await expect(promise).resolves.toEqual({ workspaces: [], org: "acme", reminted: false });
	});

	it("scopeProjects() degrades to [] on timeout: the same bound a workspace switch chains via loadProjects", async () => {
		const wire = createWireClient({ fetchImpl: hangingFetch() });
		const promise = wire.scopeProjects();
		await vi.advanceTimersByTimeAsync(SCOPE_REQUEST_TIMEOUT_MS + 500);
		await expect(promise).resolves.toEqual([]);
	});

	it("switchOrg() degrades to the honest failed ack on timeout (never a throw, never left pending)", async () => {
		const wire = createWireClient({ fetchImpl: hangingFetch() });
		const promise = wire.switchOrg("acme");
		await vi.advanceTimersByTimeAsync(SCOPE_REQUEST_TIMEOUT_MS + 500);
		await expect(promise).resolves.toEqual(FAILED_ORG_SWITCH_ACK);
	});

	it("switchWorkspace() degrades to the honest failed ack on timeout", async () => {
		const wire = createWireClient({ fetchImpl: hangingFetch() });
		const promise = wire.switchWorkspace("ws-1");
		await vi.advanceTimersByTimeAsync(SCOPE_REQUEST_TIMEOUT_MS + 500);
		await expect(promise).resolves.toEqual(FAILED_WORKSPACE_SWITCH_ACK);
	});

	it("setupTenancy() degrades to the honest unreachable state on timeout (feeds the scope-context reconciliation)", async () => {
		const wire = createWireClient({ fetchImpl: hangingFetch() });
		const promise = wire.setupTenancy();
		await vi.advanceTimersByTimeAsync(SCOPE_REQUEST_TIMEOUT_MS + 500);
		await expect(promise).resolves.toEqual(UNREACHABLE_SETUP_TENANCY);
	});

	it("a slow-but-LIVE gateway hop (well under the bound) still resolves with the REAL data, never the fallback", async () => {
		const wire = createWireClient({ fetchImpl: delayedFetch(5000, { orgs: [{ id: "acme", name: "Acme" }] }) });
		const promise = wire.scopeOrgs();
		await vi.advanceTimersByTimeAsync(5000);
		await expect(promise).resolves.toEqual([{ id: "acme", name: "Acme" }]);
	});
});
