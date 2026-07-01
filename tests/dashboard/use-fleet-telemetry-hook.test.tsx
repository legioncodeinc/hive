// @vitest-environment jsdom
/**
 * the-hive PRD-004/PRD-005 — `useFleetTelemetry` hook-level behavior. jsdom has no `EventSource`
 * (confirmed: `(globalThis as any).EventSource` is `undefined` here, same gap `wire.ts`'s
 * `logsStream` already documents), so this environment naturally exercises the REST-fallback path
 * (bz-AC-5/hr-AC-4) end to end; the SSE-fed reducer steps are covered directly in
 * `use-fleet-telemetry.test.ts` without needing a live `EventSource`.
 */

import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { useFleetTelemetry } from "../../src/dashboard/web/use-fleet-telemetry.js";

interface FetchCall {
	readonly url: string;
}

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

describe("useFleetTelemetry — REST fallback in an EventSource-less environment", () => {
	let calls: FetchCall[];
	let fleetStatusResponse: unknown;

	beforeEach(() => {
		calls = [];
		fleetStatusResponse = { supervisor: "unreachable", daemons: [] };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				calls.push({ url });
				if (url.includes("/api/registered-services")) {
					return jsonResponse({ names: ["honeycomb", "hivenectar"] });
				}
				if (url.includes("/api/fleet-status")) {
					return jsonResponse(fleetStatusResponse);
				}
				return jsonResponse({}, false);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("confirms this environment has no EventSource (documents WHY the REST path is exercised here)", () => {
		expect((globalThis as { EventSource?: unknown }).EventSource).toBeUndefined();
	});

	it("bz-AC-1/hr-AC-1: enumerates every registered service even before any telemetry (starting)", async () => {
		const { result } = renderHook(() => useFleetTelemetry({ restPollMs: 10 }));
		await waitFor(() => expect(result.current.services.map((s) => s.name)).toEqual(["honeycomb", "hivenectar"]));
		expect(result.current.services.every((s) => s.state === "starting")).toBe(true);
	});

	it("bz-AC-5/hr-AC-4: falls back to /api/fleet-status and keeps rendering rather than going blank", async () => {
		fleetStatusResponse = {
			supervisor: "reachable",
			health: "ok",
			asOf: "2026-07-01T12:00:00.000Z",
			daemons: [
				{ name: "honeycomb", health: "ok", escalation: null },
				{ name: "hivenectar", health: "unreachable", escalation: null },
			],
		};
		const { result } = renderHook(() => useFleetTelemetry({ restPollMs: 10 }));

		await waitFor(() => expect(result.current.source).toBe("rest"));
		expect(result.current.services.find((s) => s.name === "hivenectar")?.state).toBe("error");
		// A degraded sibling never blanks the OTHER row (bz-AC-7-equivalent for the hook's own state).
		expect(result.current.services.find((s) => s.name === "honeycomb")?.state).not.toBe("error");
	});

	it("keeps polling and reflects a later recovery without a remount", async () => {
		fleetStatusResponse = { supervisor: "reachable", health: "degraded", asOf: "t1", daemons: [{ name: "honeycomb", health: "degraded", escalation: null }] };
		const { result } = renderHook(() => useFleetTelemetry({ restPollMs: 10 }));

		await waitFor(() => expect(result.current.services.find((s) => s.name === "honeycomb")?.state).toBe("degraded"));

		fleetStatusResponse = { supervisor: "reachable", health: "ok", asOf: "t2", daemons: [{ name: "honeycomb", health: "ok", escalation: null }] };
		await waitFor(() => expect(result.current.services.find((s) => s.name === "honeycomb")?.state).not.toBe("degraded"));
	});
});
