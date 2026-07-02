// @vitest-environment jsdom
/**
 * hive PRD-004/PRD-005 — `useFleetTelemetry` hook-level behavior. jsdom has no `EventSource`
 * (confirmed: `(globalThis as any).EventSource` is `undefined` here, same gap `wire.ts`'s
 * `logsStream` already documents), so this environment naturally exercises the REST-fallback path
 * (bz-AC-5/hr-AC-4) end to end; the SSE-fed reducer steps are covered directly in
 * `use-fleet-telemetry.test.ts` without needing a live `EventSource`.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { useFleetTelemetry } from "../../src/dashboard/web/use-fleet-telemetry.js";
import { FLEET_TELEMETRY_EVENT_NAME } from "../../src/shared/fleet-telemetry.js";

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
					return jsonResponse({ names: ["honeycomb", "nectar"] });
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
		await waitFor(() => expect(result.current.services.map((s) => s.name)).toEqual(["honeycomb", "nectar"]));
		expect(result.current.services.every((s) => s.state === "starting")).toBe(true);
	});

	it("bz-AC-5/hr-AC-4: falls back to /api/fleet-status and keeps rendering rather than going blank", async () => {
		fleetStatusResponse = {
			supervisor: "reachable",
			health: "ok",
			asOf: "2026-07-01T12:00:00.000Z",
			daemons: [
				{ name: "honeycomb", health: "ok", escalation: null },
				{ name: "nectar", health: "unreachable", escalation: null },
			],
		};
		const { result } = renderHook(() => useFleetTelemetry({ restPollMs: 10 }));

		await waitFor(() => expect(result.current.source).toBe("rest"));
		expect(result.current.services.find((s) => s.name === "nectar")?.state).toBe("error");
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

/**
 * A minimal in-memory EventSource stand-in: enough surface for the hook (constructor,
 * add/removeEventListener, close) plus a test-side `emit` to push telemetry frames.
 */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	private readonly listeners = new Map<string, Set<EventListener>>();

	constructor(public readonly url: string) {
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: EventListener): void {
		const set = this.listeners.get(type) ?? new Set<EventListener>();
		set.add(listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.listeners.clear();
	}

	emit(type: string, event: Event): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

describe("useFleetTelemetry — time-based state transitions while the stream is quiet", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeEventSource.instances = [];
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ names: [] }) }) as unknown as Response),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("ages a quiet-but-open SSE service out of `warming` into `active` on the clock alone (no new frames)", async () => {
		const { result } = renderHook(() => useFleetTelemetry());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		const source = FakeEventSource.instances[0];
		expect(source).toBeDefined();

		// One healthy frame, then total silence: the stream stays open, no further state updates.
		const frame = JSON.stringify({
			asOf: new Date().toISOString(),
			services: [{ name: "honeycomb", health: "ok", lastSeen: null, metrics: {}, deeplake: null, telemetryFault: null }],
			logs: [],
		});
		act(() => {
			source?.emit(FLEET_TELEMETRY_EVENT_NAME, new MessageEvent(FLEET_TELEMETRY_EVENT_NAME, { data: frame }));
		});

		expect(result.current.source).toBe("sse");
		expect(result.current.services.find((s) => s.name === "honeycomb")?.state).toBe("warming");

		// Past the 10s warming grace window, with NOTHING else arriving: the ticking clock alone
		// must move the derived state forward rather than freezing it at `warming`.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(11_000);
		});
		expect(result.current.services.find((s) => s.name === "honeycomb")?.state).toBe("active");
	});
});
