/**
 * PRD-006c / PRD-006d: the honeycomb harness-connect route surface.
 *
 * Three hive-owned routes, registered on hive's app BEFORE the generic `/api/*` BFF proxy (the same
 * registration-order discipline as `/api/fleet-status` and the installer routes) so hive itself
 * answers them by SHELLING the honeycomb CLI, rather than proxying to a workload daemon:
 *
 *   - POST /api/onboarding/harness/connect      -> `honeycomb harness connect --json`   (006c)
 *   - GET  /api/diagnostics/harness-connect-status -> `honeycomb harness status --json` (006d)
 *   - POST /api/diagnostics/harness-repair      -> `honeycomb harness repair [h] --json`(006d)
 *
 * The status read is AUTHORITATIVE: it deliberately does NOT reuse the passive
 * `/api/diagnostics/harnesses` proxy for the plugin-enabled bit, because honeycomb documents that
 * endpoint as accurate only post-reconcile; this surface derives the live plugin-enabled state.
 *
 * SECURITY: like the installer's shell-out surface, every route runs the Host + Origin guard
 * (`installer/security.ts`), the DNS-rebinding + cross-origin drive-by defense for a loopback
 * endpoint that shells a process. The onboarding token is intentionally NOT required here: the
 * harness-connect service stays decoupled from the installer's one-time-token lifecycle, and the
 * Host + Origin checks are the meaningful CSRF/rebinding defense. The connect/repair triggers only
 * run honeycomb's idempotent, bounded, self-healing reconcile and return ids/booleans/status
 * strings (NO secret, NO path).
 */

import type { Context, Hono } from "hono";

import { hostAllowed, originAllowed } from "../installer/security.js";
import { createHoneycombCli, isValidHarnessId, type HoneycombCli, type HoneycombCliOptions } from "./honeycomb-cli.js";

/** Service options: the honeycomb-CLI seams plus a test-only injected client. */
export interface HarnessConnectServiceOptions extends HoneycombCliOptions {
	/** Test seam: inject a fake honeycomb CLI, bypassing spawn + bin resolution entirely. */
	readonly cli?: HoneycombCli;
}

/** The assembled harness-connect service: a route registrar plus its CLI client (exposed for tests). */
export interface HarnessConnectService {
	register(app: Hono): void;
	readonly cli: HoneycombCli;
}

function forbidden(c: Context): Response {
	return c.json({ error: "forbidden" }, 403);
}

/** The parsed `/harness-repair` body: a valid (possibly absent) target, or a rejected-shape flag. */
type RepairHarness = { readonly ok: true; readonly harness: string | undefined } | { readonly ok: false };

/** Host + Origin cross-origin guard (mirrors the installer's is-AC-7/is-AC-8 checks). */
function guardCrossOrigin(c: Context): Response | null {
	if (!hostAllowed(c.req.header("host"))) return forbidden(c);
	if (!originAllowed(c.req.method, c.req.header("origin"))) return forbidden(c);
	return null;
}

/** Read a request JSON body, returning `undefined` on any parse failure (never throws). */
async function readJsonBody(c: Context): Promise<unknown | undefined> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}

/**
 * Validate the optional `harness` off a `/harness-repair` body, ignoring any other field. An absent
 * (or empty) harness targets the default. A PRESENT harness must be a canonical harness id: anything
 * else (a `--flag`, a non-string, a slug with metacharacters) is rejected as an invalid shape so it
 * can never reach the honeycomb spawn argv (argument-injection defense at the HTTP boundary).
 */
function readRepairHarness(body: unknown): RepairHarness {
	if (typeof body !== "object" || body === null) return { ok: true, harness: undefined };
	const harness = (body as { harness?: unknown }).harness;
	if (harness === undefined || harness === "") return { ok: true, harness: undefined };
	if (typeof harness !== "string" || !isValidHarnessId(harness)) return { ok: false };
	return { ok: true, harness };
}

/**
 * Build the harness-connect service over a shared honeycomb-CLI client (built once). Every route is
 * fail-soft by way of the client (a down/absent honeycomb CLI degrades to a clean status, never a
 * throw), so onboarding + the dashboard never hang or dead-end (c-AC-5 / d-AC-5).
 */
export function createHarnessConnectService(options: HarnessConnectServiceOptions = {}): HarnessConnectService {
	const cli = options.cli ?? createHoneycombCli(options);

	const register = (app: Hono): void => {
		// 006c: the onboarding "Connect your coding assistant" trigger.
		app.post("/api/onboarding/harness/connect", async (c) => {
			const rejection = guardCrossOrigin(c);
			if (rejection !== null) return rejection;
			return c.json(await cli.connect());
		});

		// 006d: the AUTHORITATIVE per-harness connection report (agent + plugin-enabled + last outcome).
		app.get("/api/diagnostics/harness-connect-status", async (c) => {
			const rejection = guardCrossOrigin(c);
			if (rejection !== null) return rejection;
			return c.json(await cli.status());
		});

		// 006d: Reconnect / Repair - re-run the connector setup for one (or the default) harness.
		app.post("/api/diagnostics/harness-repair", async (c) => {
			const rejection = guardCrossOrigin(c);
			if (rejection !== null) return rejection;
			const parsed = readRepairHarness(await readJsonBody(c));
			if (!parsed.ok) return c.json({ error: "invalid harness" }, 400);
			return c.json(await cli.repair(parsed.harness));
		});
	};

	return { register, cli };
}
