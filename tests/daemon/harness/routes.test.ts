/**
 * PRD-006c/006d: the honeycomb harness-connect routes. Verifies the three routes delegate to the
 * injected CLI, the repair route parses the optional `{ harness }` body, the Host + Origin
 * cross-origin guard rejects foreign/rebound callers, and the routes stay fail-soft (a `cli-absent`
 * CLI result is returned verbatim with a 200, never a 5xx).
 */

import { Hono } from "hono";

import { createHarnessConnectService } from "../../../src/daemon/harness/index.js";
import type {
	HarnessConnectResult,
	HarnessRepairResult,
	HarnessStatusReport,
	HoneycombCli,
} from "../../../src/daemon/harness/honeycomb-cli.js";

const HIVE_HOST = "127.0.0.1:3853";
const HIVE_ORIGIN = "http://127.0.0.1:3853";

interface FakeCliParts {
	readonly connect?: HarnessConnectResult;
	readonly status?: HarnessStatusReport;
	readonly repair?: HarnessRepairResult;
}

function fakeCli(parts: FakeCliParts = {}): {
	cli: HoneycombCli;
	connect: ReturnType<typeof vi.fn>;
	status: ReturnType<typeof vi.fn>;
	repair: ReturnType<typeof vi.fn>;
} {
	const connect = vi.fn(async (): Promise<HarnessConnectResult> => parts.connect ?? { harness: "claude-code", status: "connected" });
	const status = vi.fn(async (): Promise<HarnessStatusReport> => parts.status ?? { harnesses: [] });
	const repair = vi.fn(async (): Promise<HarnessRepairResult> => parts.repair ?? { harness: "claude-code", status: "connected", connected: true });
	return { cli: { connect, status, repair }, connect, status, repair };
}

function makeApp(parts: FakeCliParts = {}) {
	const parts2 = fakeCli(parts);
	const app = new Hono();
	createHarnessConnectService({ cli: parts2.cli }).register(app);
	return { app, ...parts2 };
}

interface Req {
	readonly method?: string;
	readonly body?: unknown;
	readonly host?: string;
	readonly origin?: string | null;
}

function request(app: Hono, path: string, options: Req = {}): Promise<Response> {
	const method = options.method ?? "GET";
	const headers: Record<string, string> = { host: options.host ?? HIVE_HOST };
	if (options.origin !== null) headers.origin = options.origin ?? HIVE_ORIGIN;
	if (options.body !== undefined) headers["content-type"] = "application/json";
	return app.request(`http://${headers.host}${path}`, {
		method,
		headers,
		...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
	});
}

describe("harness-connect routes", () => {
	it("POST /api/onboarding/harness/connect returns the CLI connect result", async () => {
		const { app, connect } = makeApp({ connect: { harness: "claude-code", status: "connected" } });
		const res = await request(app, "/api/onboarding/harness/connect", { method: "POST", origin: HIVE_ORIGIN });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ harness: "claude-code", status: "connected" });
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("GET /api/diagnostics/harness-connect-status returns the per-harness report", async () => {
		const report: HarnessStatusReport = {
			harnesses: [{ harness: "claude-code", agentPresent: true, pluginEnabled: true, connected: true, lastOutcome: "wired" }],
		};
		const { app, status } = makeApp({ status: report });
		const res = await request(app, "/api/diagnostics/harness-connect-status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(report);
		expect(status).toHaveBeenCalledTimes(1);
	});

	it("POST /api/diagnostics/harness-repair passes the named harness through to the CLI", async () => {
		const { app, repair } = makeApp({ repair: { harness: "codex", status: "connected", connected: true } });
		const res = await request(app, "/api/diagnostics/harness-repair", { method: "POST", body: { harness: "codex" } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ harness: "codex", status: "connected", connected: true });
		expect(repair).toHaveBeenCalledWith("codex");
	});

	it("POST /api/diagnostics/harness-repair defaults to no harness on an empty body", async () => {
		const { app, repair } = makeApp();
		await request(app, "/api/diagnostics/harness-repair", { method: "POST", origin: HIVE_ORIGIN });
		expect(repair).toHaveBeenCalledWith(undefined);
	});

	it("rejects a foreign Host (DNS-rebinding defense) with 403 and never shells", async () => {
		const { app, connect } = makeApp();
		const res = await request(app, "/api/onboarding/harness/connect", { method: "POST", host: "evil.example.com" });
		expect(res.status).toBe(403);
		expect(connect).not.toHaveBeenCalled();
	});

	it("rejects a foreign Origin on a state-changing POST with 403", async () => {
		const { app, connect } = makeApp();
		const res = await request(app, "/api/onboarding/harness/connect", { method: "POST", origin: "https://evil.example.com" });
		expect(res.status).toBe(403);
		expect(connect).not.toHaveBeenCalled();
	});

	it("rejects a POST with no Origin header with 403", async () => {
		const { app, repair } = makeApp();
		const res = await request(app, "/api/diagnostics/harness-repair", { method: "POST", origin: null });
		expect(res.status).toBe(403);
		expect(repair).not.toHaveBeenCalled();
	});

	it("fail-soft: a cli-absent connect result is returned verbatim with a 200 (never a 5xx)", async () => {
		const { app } = makeApp({ connect: { harness: "claude-code", status: "cli-absent" } });
		const res = await request(app, "/api/onboarding/harness/connect", { method: "POST", origin: HIVE_ORIGIN });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ harness: "claude-code", status: "cli-absent" });
	});
});
