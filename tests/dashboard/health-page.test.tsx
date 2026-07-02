// @vitest-environment jsdom
/**
 * hive PRD-005b (per-service metrics + Deep Lake stats, rendered generically) and PRD-005c
 * (live log tail + verbosity filtering + bounded buffer). Exercises the REST-fallback path
 * (jsdom has no `EventSource`) since only the fallback carries no `logs`/metrics through the
 * pure hook tests already covering the SSE path directly.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HealthPage } from "../../src/dashboard/web/pages/health.js";
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

	it("lg-AC-4: exposes a verbosity selector defaulting to info and shows the empty-logs state (fallback carries no logs)", async () => {
		render(<HealthPage {...pageProps()} />);
		await waitFor(() => expect(screen.getByTestId("log-verbosity-select")).toBeTruthy());
		expect((screen.getByTestId("log-verbosity-select") as HTMLSelectElement).value).toBe("info");
		expect(screen.getByTestId("health-logs-empty")).toBeTruthy();
	});

	it("lg-AC-5: changing verbosity updates the select value without a page reload", async () => {
		render(<HealthPage {...pageProps()} />);
		await waitFor(() => expect(screen.getByTestId("log-verbosity-select")).toBeTruthy());
		fireEvent.change(screen.getByTestId("log-verbosity-select"), { target: { value: "error" } });
		expect((screen.getByTestId("log-verbosity-select") as HTMLSelectElement).value).toBe("error");
	});
});
