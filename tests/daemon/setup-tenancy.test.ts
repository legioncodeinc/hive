/**
 * PRD-011c: fail-closed tenancy read for the portal gate (tg-AC-4/5/7). The registry module is
 * mocked so the tg-AC-7 non-loopback outcome is drivable: the real `resolveDaemonBases` can never
 * return a non-loopback base (the registry parser rejects those entries at parse time), so the
 * `isLoopbackBaseUrl` re-check in `fetchTenancySelected` is pure defense in depth against a future
 * base-resolution change, reachable only by faking the resolver.
 */

import { DEFAULT_DAEMON_BASES } from "../../src/shared/daemon-routing.js";

const resolveDaemonBasesMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/daemon/registry.js", () => ({ resolveDaemonBases: resolveDaemonBasesMock }));

import { fetchTenancySelected, type SetupTenancyFetchImpl } from "../../src/daemon/setup-tenancy.js";

beforeEach(() => {
	resolveDaemonBasesMock.mockReturnValue({ ...DEFAULT_DAEMON_BASES });
});

function tenancyFetch(selected: boolean): SetupTenancyFetchImpl {
	return async () =>
		new Response(JSON.stringify({ selected, pending: !selected, authenticated: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
}

describe("fetchTenancySelected", () => {
	it("tg-AC-5 returns true when honeycomb reports selected: true", async () => {
		expect(await fetchTenancySelected(tenancyFetch(true))).toBe(true);
	});

	it("tg-AC-4 returns false when selected is false", async () => {
		expect(await fetchTenancySelected(tenancyFetch(false))).toBe(false);
	});

	it("tg-AC-4 fails closed on network error", async () => {
		const throwing: SetupTenancyFetchImpl = async () => {
			throw new Error("ECONNREFUSED");
		};
		expect(await fetchTenancySelected(throwing)).toBe(false);
	});

	it("tg-AC-4 fails closed on non-OK response", async () => {
		const bad: SetupTenancyFetchImpl = async () => new Response("nope", { status: 502 });
		expect(await fetchTenancySelected(bad)).toBe(false);
	});

	it("tg-AC-4 fails closed on malformed JSON", async () => {
		const bad: SetupTenancyFetchImpl = async () => new Response("not-json", { status: 200 });
		expect(await fetchTenancySelected(bad)).toBe(false);
	});

	it("tg-AC-7 fails closed to unconfirmed when the resolved honeycomb base is non-loopback, without fetching", async () => {
		resolveDaemonBasesMock.mockReturnValue({ honeycomb: "http://203.0.113.7:3850", nectar: DEFAULT_DAEMON_BASES.nectar });
		const neverFetch = vi.fn<SetupTenancyFetchImpl>(async () => {
			throw new Error("must never be reached for a non-loopback base");
		});
		expect(await fetchTenancySelected(neverFetch)).toBe(false);
		expect(neverFetch).not.toHaveBeenCalled();
	});

	it("threads the abort signal into the upstream fetch", async () => {
		let received: AbortSignal | undefined;
		const capture: SetupTenancyFetchImpl = async (_input, init) => {
			received = init?.signal;
			return new Response(JSON.stringify({ selected: true }), { status: 200, headers: { "content-type": "application/json" } });
		};
		await fetchTenancySelected(capture, { signal: AbortSignal.timeout(1000) });
		expect(received).toBeInstanceOf(AbortSignal);
	});
});
