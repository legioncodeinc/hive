// @vitest-environment jsdom
/**
 * hive PRD-004a — the `/buzzing` readiness screen. jsdom has no `EventSource`, so the shared
 * telemetry hook naturally exercises its REST-fallback path here (mirrors `use-fleet-telemetry-hook.test.tsx`).
 * A single mutable `fleetStatusResponse` (rather than a shift-based queue) avoids ordering
 * flakiness between the hook's own fallback poll and this screen's independent dismissal poll —
 * both target `GET /api/fleet-status`.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { BuzzingScreen } from "../../src/dashboard/web/buzzing-screen.js";

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

describe("BuzzingScreen", () => {
	let fleetStatusResponse: unknown;
	let registeredNames: readonly string[];

	beforeEach(() => {
		fleetStatusResponse = { supervisor: "unreachable", daemons: [] };
		registeredNames = ["honeycomb", "nectar"];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				if (url.includes("/api/registered-services")) return jsonResponse({ names: registeredNames });
				if (url.includes("/api/fleet-status")) return jsonResponse(fleetStatusResponse);
				return jsonResponse({}, false);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("bz-AC-1/bz-AC-2: shows one tile per registered service, including a never-seen one (starting)", async () => {
		render(<BuzzingScreen assetBase="assets" pollMs={10} onReady={() => {}} />);
		await waitFor(() => expect(screen.getByTestId("buzzing-tile-grid")).toBeTruthy());
		expect(screen.getByTestId("buzzing-tile-honeycomb")).toBeTruthy();
		expect(screen.getByTestId("buzzing-tile-nectar")).toBeTruthy();
		expect(screen.getByTestId("buzzing-tile-state-honeycomb").textContent).toBe("starting");
	});

	it("rs-AC-6: supervisor unreachable with no registered services shows the waiting-on-doctor state", async () => {
		registeredNames = [];
		render(<BuzzingScreen assetBase="assets" pollMs={10} onReady={() => {}} />);
		await waitFor(() => expect(screen.getByTestId("buzzing-empty")).toBeTruthy());
		expect(screen.getByTestId("buzzing-empty").textContent).toMatch(/waiting on doctor/i);
	});

	it("bz-AC-7/bz-AC-8: one service failing flips only its own tile; the rest stay visible", async () => {
		fleetStatusResponse = {
			supervisor: "reachable",
			health: "degraded",
			asOf: "2026-07-01T12:00:00.000Z",
			daemons: [
				{ name: "honeycomb", health: "ok", escalation: null },
				{ name: "nectar", health: "unreachable", escalation: null },
			],
		};
		render(<BuzzingScreen assetBase="assets" pollMs={10} onReady={() => {}} />);

		await waitFor(() => expect(screen.getByTestId("buzzing-tile-state-nectar").textContent).toBe("error"));
		expect(screen.getByTestId("buzzing-tile-honeycomb")).toBeTruthy();
		expect(screen.getByTestId("buzzing-tile-state-honeycomb").textContent).not.toBe("error");
	});

	it("bz-AC-9: transitions away once isFleetReady() is satisfied", async () => {
		fleetStatusResponse = { supervisor: "unreachable", daemons: [] };
		const onReady = vi.fn();
		render(<BuzzingScreen assetBase="assets" pollMs={10} onReady={onReady} />);

		await waitFor(() => expect(screen.getByTestId("buzzing-screen")).toBeTruthy());
		expect(onReady).not.toHaveBeenCalled();

		fleetStatusResponse = {
			supervisor: "reachable",
			health: "ok",
			asOf: "2026-07-01T12:00:00.000Z",
			daemons: [{ name: "honeycomb", health: "ok", escalation: null }],
		};

		await waitFor(() => expect(onReady).toHaveBeenCalled());
	});

	it("never stacks overlapping readiness polls while a /api/fleet-status request is still in flight", async () => {
		let fleetStatusCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				if (url.includes("/api/registered-services")) return jsonResponse({ names: registeredNames });
				if (url.includes("/api/fleet-status")) {
					fleetStatusCalls += 1;
					// A hung daemon: the request never resolves. The interval keeps firing well past
					// pollMs, so without the in-flight guard this would stack a call per tick.
					return new Promise<Response>(() => {});
				}
				return jsonResponse({}, false);
			}),
		);

		render(<BuzzingScreen assetBase="assets" pollMs={10} onReady={() => {}} />);
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Exactly one from this screen's dismissal poll plus one from useFleetTelemetry's own
		// fallback poll (its default interval is far longer than this window).
		expect(fleetStatusCalls).toBeLessThanOrEqual(2);
	});

	it("bz-AC-10: stays mounted (no dismissal call) while the fleet is not yet ready", async () => {
		// An explicit no-response (unreachable) is the only answered-doctor state that reads
		// not-ready: degraded is UP (honeycomb/nectar boot degraded until a workspace is bound).
		fleetStatusResponse = {
			supervisor: "reachable",
			health: "unreachable",
			asOf: "2026-07-01T12:00:00.000Z",
			daemons: [{ name: "honeycomb", health: "unreachable", escalation: null }],
		};
		const onReady = vi.fn();
		render(<BuzzingScreen assetBase="assets" pollMs={10} onReady={onReady} />);

		await waitFor(() => expect(screen.getByTestId("buzzing-screen")).toBeTruthy());
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(onReady).not.toHaveBeenCalled();
	});

	it("rs-AC-4 polls GET /api/fleet-status on an interval between 1000ms and 2000ms", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.includes("/api/registered-services")) return jsonResponse({ names: registeredNames });
			if (url.includes("/api/fleet-status")) return jsonResponse(fleetStatusResponse);
			return jsonResponse({}, false);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<BuzzingScreen assetBase="assets" onReady={() => {}} />);
		await vi.advanceTimersByTimeAsync(0);
		const callsAfterMount = fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes("/api/fleet-status")).length;
		expect(callsAfterMount).toBeGreaterThanOrEqual(1);

		await vi.advanceTimersByTimeAsync(999);
		const callsBeforeMin = fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes("/api/fleet-status")).length;

		await vi.advanceTimersByTimeAsync(601);
		const callsAfterMin = fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes("/api/fleet-status")).length;
		expect(callsAfterMin).toBeGreaterThan(callsBeforeMin);

		await vi.advanceTimersByTimeAsync(1000);
		const callsAfterMax = fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes("/api/fleet-status")).length;
		expect(callsAfterMax).toBeGreaterThan(callsAfterMin);

		vi.useRealTimers();
	});
});
