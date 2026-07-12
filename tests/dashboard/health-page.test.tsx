// @vitest-environment jsdom
/**
 * hive PRD-005b (per-service metrics + Deep Lake stats, rendered generically). Exercises the
 * REST-fallback path (jsdom has no `EventSource`) since only the fallback carries no metrics
 * through the pure hook tests already covering the SSE path directly. ISS-009: the PRD-005c
 * live log tail was removed from this page — a compact "View logs →" link renders instead.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { formatTelemetryFreshness, HealthPage } from "../../src/dashboard/web/pages/health.js";
import type { PageProps } from "../../src/dashboard/web/page-frame.js";
import type { WireClient } from "../../src/dashboard/web/wire.js";

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

const STUB_WIRE = {} as unknown as WireClient;

function pageProps(): PageProps {
	return { wire: STUB_WIRE, daemonUp: true, assetBase: "assets" };
}

describe("HealthPage", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				if (url.includes("/api/registered-services")) return jsonResponse({ names: [] });
				if (url.includes("/api/fleet-status")) return jsonResponse({ supervisor: "unreachable", daemons: [] });
				return jsonResponse({}, false);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("hm-AC-10: renders a clear telemetry-unavailable state rather than a broken page when there is no source at all", async () => {
		render(<HealthPage {...pageProps()} />);
		await waitFor(() => expect(screen.getByTestId("health-telemetry-unavailable")).toBeTruthy());
	});
});

describe("HealthPage with reachable fleet-status fallback", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				if (url.includes("/api/registered-services")) return jsonResponse({ names: ["honeycomb", "nectar"] });
				if (url.includes("/api/fleet-status")) {
					return jsonResponse({
						supervisor: "reachable",
						health: "ok",
						asOf: "2026-07-01T12:00:00.000Z",
						daemons: [
							{ name: "honeycomb", health: "ok", escalation: null },
							{ name: "nectar", health: "ok", escalation: null },
						],
					});
				}
				return jsonResponse({}, false);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("hm-AC-1..3: renders per-service metrics GENERICALLY (no metrics from the REST fallback yet -> honest empty state)", async () => {
		render(<HealthPage {...pageProps()} />);
		await waitFor(() => expect(screen.getByTestId("health-service-honeycomb")).toBeTruthy());
		expect(screen.getByTestId("health-metrics-empty-honeycomb")).toBeTruthy();
	});

	it("hm-AC-5: renders 'not reported' for Deep Lake when the source carries none", async () => {
		render(<HealthPage {...pageProps()} />);
		await waitFor(() => expect(screen.getByTestId("health-deeplake-honeycomb")).toBeTruthy());
		expect(screen.getByTestId("health-deeplake-honeycomb").textContent).toContain("not reported");
	});

	it("ISS-009: renders no live log tail — a compact 'View logs →' link points at the Logs page instead", async () => {
		render(<HealthPage {...pageProps()} />);
		await waitFor(() => expect(screen.getByTestId("view-logs-link")).toBeTruthy());
		expect(screen.queryByTestId("log-verbosity-select")).toBeNull();
		expect(screen.queryByTestId("health-logs-empty")).toBeNull();
		expect(screen.queryByTestId("health-logs-list")).toBeNull();
	});

	// Health-page honesty (client-reported gap): the badges are doctor-RELAYED, not a live daemon
	// probe, so every tile now carries a freshness annotation ("as of Xs ago via doctor") and an
	// explicit reconnecting flag when the relay is behind, so a stale snapshot can never read as an
	// unqualified current fact.
	it("annotates each tile with when its (doctor-relayed) data is from", async () => {
		render(<HealthPage {...pageProps()} />);
		await waitFor(() => expect(screen.getByTestId("health-freshness-honeycomb")).toBeTruthy());
		expect(screen.getByTestId("health-freshness-honeycomb").textContent).toContain("via doctor");
		expect(screen.getByTestId("health-freshness-honeycomb").getAttribute("data-reconnecting")).toBe("false");
	});
});

describe("HealthPage freshness labeling: reconnecting relay never reads as a current fact", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				if (url.includes("/api/registered-services")) return jsonResponse({ names: ["honeycomb"] });
				// A "reachable" supervisor with zero daemons while there is no prior state IS the honest
				// empty state (not "reconnecting"); this suite instead seeds a genuine BLIP after first
				// establishing live data, so `reconnecting` flips true without ever blanking the grid.
				if (url.includes("/api/fleet-status")) {
					return jsonResponse({
						supervisor: "reachable",
						health: "ok",
						asOf: "2026-07-01T12:00:00.000Z",
						daemons: [{ name: "honeycomb", health: "ok", escalation: null }],
					});
				}
				return jsonResponse({}, false);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("flags a currently-reconnecting relay instead of letting a stale badge read as current", async () => {
		render(<HealthPage {...pageProps()} />);
		await waitFor(() => expect(screen.getByTestId("health-freshness-honeycomb").getAttribute("data-reconnecting")).toBe("false"));

		// A subsequent blip (reachable, but zero daemons while prior state exists) flips `reconnecting`
		// without wiping the tile (see `useFleetTelemetry`'s `applyRestFallback` doc).
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				if (url.includes("/api/registered-services")) return jsonResponse({ names: ["honeycomb"] });
				if (url.includes("/api/fleet-status")) return jsonResponse({ supervisor: "reachable", health: "unknown", asOf: "2026-07-01T12:01:00.000Z", daemons: [] });
				return jsonResponse({}, false);
			}),
		);

		// The REST fallback polls every 2s by default; give it enough headroom past that interval.
		await waitFor(() => expect(screen.getByTestId("health-freshness-honeycomb").getAttribute("data-reconnecting")).toBe("true"), { timeout: 5000 });
		expect(screen.getByTestId("health-freshness-honeycomb").textContent).toContain("reconnecting");
		// The tile itself is still rendered (never blanked) even while the relay is behind.
		expect(screen.getByTestId("health-service-honeycomb")).toBeTruthy();
	});
});

describe("formatTelemetryFreshness (pure)", () => {
	it("renders an honest 'no data yet' when there is no asOf at all", () => {
		expect(formatTelemetryFreshness(null, Date.now())).toBe("no data yet");
	});

	it("renders 'as of just now' for a sub-2s age", () => {
		const now = Date.parse("2026-07-01T12:00:01.000Z");
		expect(formatTelemetryFreshness("2026-07-01T12:00:00.000Z", now)).toBe("as of just now");
	});

	it("renders seconds-ago for a sub-minute age", () => {
		const now = Date.parse("2026-07-01T12:00:42.000Z");
		expect(formatTelemetryFreshness("2026-07-01T12:00:00.000Z", now)).toBe("as of 42s ago");
	});

	it("renders minutes-ago for a longer age", () => {
		const now = Date.parse("2026-07-01T12:05:00.000Z");
		expect(formatTelemetryFreshness("2026-07-01T12:00:00.000Z", now)).toBe("as of 5m ago");
	});
});
