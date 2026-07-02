/**
 * the-hive PRD-004/PRD-005 — the server-side fleet-telemetry SSE relay (`telemetry-proxy.ts`).
 * hr-AC-6/sd-AC-6: the browser only ever reaches this same-origin relay, never hivedoctor's
 * `:3852` directly. Exercised through a bare Hono app (`app.request(...)`, no real sockets),
 * matching this repo's existing `tests/daemon/*` style.
 */

import { Hono } from "hono";

import { createTelemetryStreamHandler, type TelemetryFetch } from "../../src/daemon/telemetry-proxy.js";
import { HIVEDOCTOR_EVENTS_URL } from "../../src/shared/constants.js";

function appWith(fetchImpl: TelemetryFetch, hivedoctorEventsUrl?: string): Hono {
	const app = new Hono();
	app.get("/api/telemetry/stream", createTelemetryStreamHandler({ fetchImpl, hivedoctorEventsUrl }));
	return app;
}

function sseStreamResponse(frames: readonly string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("createTelemetryStreamHandler", () => {
	it("connects to hivedoctor's REAL fixed events URL, never a derived/registry-sourced one", async () => {
		const seen: string[] = [];
		const fetchImpl: TelemetryFetch = async (url) => {
			seen.push(url);
			return sseStreamResponse(["event: fleet-telemetry\ndata: {}\n\n"]);
		};

		const res = await appWith(fetchImpl).request("http://thehive.local/api/telemetry/stream");
		expect(res.status).toBe(200);
		expect(seen).toEqual([HIVEDOCTOR_EVENTS_URL]);
	});

	it("streams the upstream SSE bytes through unchanged (never buffered/re-serialized)", async () => {
		const frame = "event: fleet-telemetry\ndata: {\"asOf\":\"2026-07-01T12:00:00.000Z\",\"services\":[],\"logs\":[]}\n\n";
		const fetchImpl: TelemetryFetch = async () => sseStreamResponse([frame]);

		const res = await appWith(fetchImpl).request("http://thehive.local/api/telemetry/stream");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const body = await res.text();
		expect(body).toBe(frame);
	});

	it("fails soft with a 502 (no body) when hivedoctor is unreachable", async () => {
		const fetchImpl: TelemetryFetch = async () => {
			throw new Error("ECONNREFUSED");
		};
		const res = await appWith(fetchImpl).request("http://thehive.local/api/telemetry/stream");
		expect(res.status).toBe(502);
	});

	it("fails soft with a 502 when hivedoctor responds non-2xx", async () => {
		const fetchImpl: TelemetryFetch = async () => new Response(null, { status: 500 });
		const res = await appWith(fetchImpl).request("http://thehive.local/api/telemetry/stream");
		expect(res.status).toBe(502);
	});

	it("never fetches an off-loopback URL even if misconfigured (SSRF guard, defense in depth)", async () => {
		const seen: string[] = [];
		const fetchImpl: TelemetryFetch = async (url) => {
			seen.push(url);
			return sseStreamResponse([]);
		};
		const res = await appWith(fetchImpl, "http://evil.example.com/events").request("http://thehive.local/api/telemetry/stream");
		expect(res.status).toBe(502);
		expect(seen).toEqual([]);
	});

	it("propagates the incoming request's abort signal to the upstream fetch (no orphaned upstream connection)", async () => {
		let receivedSignal: AbortSignal | undefined;
		const fetchImpl: TelemetryFetch = async (_url, init) => {
			receivedSignal = init?.signal;
			return sseStreamResponse([]);
		};
		await appWith(fetchImpl).request("http://thehive.local/api/telemetry/stream");
		expect(receivedSignal).toBeDefined();
	});

	it('pins redirect: "error" on the upstream fetch so a 30x can never take the relay off-loopback (SSRF guard)', async () => {
		let receivedRedirect: string | undefined;
		const fetchImpl: TelemetryFetch = async (_url, init) => {
			receivedRedirect = init?.redirect;
			return sseStreamResponse([]);
		};
		await appWith(fetchImpl).request("http://thehive.local/api/telemetry/stream");
		expect(receivedRedirect).toBe("error");
	});
});
