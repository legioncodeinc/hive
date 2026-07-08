/**
 * PRD-006c / PRD-006d: the hive-side honeycomb harness-connect CLI client.
 *
 * Honeycomb (a separate product) documents `honeycomb harness connect|status|repair [harness]
 * --json` as the AUTHORITATIVE surface for plugin wiring + connection status. The reconcile it
 * delegates to is CLI-process-scoped (armed from honeycomb's `onDaemonUp` seam, at its reconcile
 * tier), so there is deliberately NO daemon HTTP endpoint that could expose it. Hive therefore
 * SHELLS the honeycomb CLI for this (never an HTTP mutation endpoint), the same way the installer
 * shells npm: it resolves the package's real `*.js` bin entry and spawns
 * `process.execPath [entry.js, "harness", <sub>, "--json"]` argv-safe (`shell:false`, Windows-safe),
 * reusing `installer/bin-resolver.ts` + `installer/spawn.ts`.
 *
 * FAIL-SOFT is the contract (c-AC-5 / d-AC-5): a missing/absent honeycomb CLI, a spawn error, a
 * timeout, a non-zero exit with no parseable JSON, or a malformed body all degrade to a clean
 * `cli-absent`/`error` status, never a throw. A down honeycomb CLI must never break onboarding or
 * the dashboard. Every result carries ids + booleans + a stable status string only (NO secret, NO
 * path): honeycomb's own contract is already redacted, and this client only re-parses that shape.
 */

import { z } from "zod";

import { globalNodeModulesDir, resolveNpmPrefixViaCli, resolvePackageBinJs } from "../installer/bin-resolver.js";
import { createInstallerConfig, type InstallerConfig } from "../installer/config.js";

/** The npm package that ships the `honeycomb` bin (resolved on the global prefix). */
export const HONEYCOMB_PACKAGE = "@legioncodeinc/honeycomb" as const;
/** The bin name inside that package's `package.json#bin` map. */
export const HONEYCOMB_BIN = "honeycomb" as const;
/** The default harness the connect/repair triggers target when none is named. */
export const DEFAULT_HARNESS = "claude-code" as const;
/** The bounded per-call timeout: a hung honeycomb process must never wedge onboarding/the dashboard. */
export const HONEYCOMB_CLI_TIMEOUT_MS = 15_000 as const;

/**
 * The renderable connect status, mirroring honeycomb's `ConnectStatus` field-for-field:
 *   - `connected`    - the plugin is enabled (c-AC-2).
 *   - `agent-absent` - the harness agent is not installed (the one case automation cannot self-heal).
 *   - `cli-absent`   - the harness CLI is not on PATH; nothing to wire yet.
 *   - `error`        - a probe/wire threw or timed out; absorbed fail-soft (c-AC-5).
 */
export const CONNECT_STATUSES = ["connected", "agent-absent", "cli-absent", "error"] as const;
export type ConnectStatus = (typeof CONNECT_STATUSES)[number];
const ConnectStatusSchema = z.enum(CONNECT_STATUSES);

/** `honeycomb harness connect --json` result shape (c-AC-1/4/5). NO secret, NO path. */
export const HarnessConnectResultSchema = z.object({
	harness: z.string(),
	status: ConnectStatusSchema,
	detail: z.string().optional(),
});
export type HarnessConnectResult = z.infer<typeof HarnessConnectResultSchema>;

/** One harness's read-only connection state from `honeycomb harness status --json` (d-AC-2/4). */
export const HarnessConnectionStateSchema = z.object({
	harness: z.string(),
	agentPresent: z.boolean(),
	pluginEnabled: z.boolean(),
	connected: z.boolean(),
	lastOutcome: z.string().optional(),
	lastOutcomeAt: z.string().optional(),
});
export type HarnessConnectionState = z.infer<typeof HarnessConnectionStateSchema>;

/** `honeycomb harness status --json` envelope: one row per configured harness. */
export const HarnessStatusReportSchema = z.object({
	harnesses: z.array(HarnessConnectionStateSchema),
});
export type HarnessStatusReport = z.infer<typeof HarnessStatusReportSchema>;

/** `honeycomb harness repair [harness] --json` result shape (d-AC-3/5). NO secret, NO path. */
export const HarnessRepairResultSchema = z.object({
	harness: z.string(),
	status: ConnectStatusSchema,
	connected: z.boolean(),
	detail: z.string().optional(),
});
export type HarnessRepairResult = z.infer<typeof HarnessRepairResultSchema>;

/** The shelled honeycomb harness surface hive consumes. Every method is fail-soft (never throws). */
export interface HoneycombCli {
	/** `honeycomb harness connect --json`: trigger the reconcile, return the renderable status. */
	connect(): Promise<HarnessConnectResult>;
	/** `honeycomb harness status --json`: the authoritative per-harness connection report. */
	status(): Promise<HarnessStatusReport>;
	/** `honeycomb harness repair [harness] --json`: re-run the setup for one harness, updated status. */
	repair(harness?: string): Promise<HarnessRepairResult>;
}

/** Construction options: the installer config seams (spawn, bin resolution) plus a timeout override. */
export interface HoneycombCliOptions extends Partial<InstallerConfig> {
	/** Override {@link HONEYCOMB_CLI_TIMEOUT_MS} (a test injects a short window). */
	readonly timeoutMs?: number;
}

/** The two non-JSON outcomes {@link runHarnessJson} distinguishes before schema validation. */
type RunFailure = "cli-absent" | "error";

/**
 * Parse the honeycomb JSON blob out of a captured stdout tail. Tries a whole-string parse first,
 * then falls back to the first `{` ... last `}` slice so a leading bootstrap log line cannot defeat
 * the read. Returns `undefined` when nothing parseable is present (the caller maps that to `error`).
 */
function parseJsonLoose(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		const first = trimmed.indexOf("{");
		const last = trimmed.lastIndexOf("}");
		if (first === -1 || last === -1 || last <= first) return undefined;
		try {
			return JSON.parse(trimmed.slice(first, last + 1));
		} catch {
			return undefined;
		}
	}
}

/** Resolve the real `honeycomb` `*.js` bin entry on the global npm prefix, or `null` when absent. */
async function resolveHoneycombCliJs(config: InstallerConfig): Promise<string | null> {
	const prefix = await config.resolveNpmPrefix();
	if (prefix === null) return null;
	const nodeModulesDir = globalNodeModulesDir(prefix, config.platform);
	return resolvePackageBinJs(config, nodeModulesDir, HONEYCOMB_PACKAGE, HONEYCOMB_BIN);
}

/**
 * Shell `honeycomb harness <args> --json` argv-safe and return the parsed JSON, or a {@link RunFailure}.
 * `cli-absent` when the bin cannot be resolved; `error` on a spawn throw, a timeout/abort, or a body
 * with no parseable JSON. The JSON is parsed regardless of exit code (honeycomb prints the status
 * blob to stdout even when a non-connected outcome exits non-zero).
 */
async function runHarnessJson(
	config: InstallerConfig,
	timeoutMs: number,
	args: readonly string[],
): Promise<unknown | RunFailure> {
	const cliJs = await resolveHoneycombCliJs(config);
	if (cliJs === null) return "cli-absent";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const result = await config.spawn(config.execPath, [cliJs, "harness", ...args, "--json"], {
			signal: controller.signal,
		});
		const parsed = parseJsonLoose(result.stdoutTail);
		return parsed === undefined ? "error" : parsed;
	} catch {
		return "error";
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Build the shared honeycomb-CLI client. Defaults are the real production seams (argv-safe spawn,
 * `npm prefix -g` bin resolution), memoized so `npm prefix -g` runs at most once per process
 * (mirrors `createInstallerService`). A test injects fake seams (or overrides the whole client at
 * the route layer) so no real honeycomb binary or home dir is touched.
 */
export function createHoneycombCli(options: HoneycombCliOptions = {}): HoneycombCli {
	const base = createInstallerConfig(options);
	const timeoutMs = options.timeoutMs ?? HONEYCOMB_CLI_TIMEOUT_MS;

	// Memoize `npm prefix -g` (once per process), exactly as the installer service does.
	let prefixPromise: Promise<string | null> | null = null;
	const config: InstallerConfig = {
		...base,
		resolveNpmPrefix: () => {
			if (prefixPromise === null) {
				prefixPromise = options.resolveNpmPrefix ? options.resolveNpmPrefix() : resolveNpmPrefixViaCli(config);
			}
			return prefixPromise;
		},
	};

	return {
		async connect(): Promise<HarnessConnectResult> {
			const raw = await runHarnessJson(config, timeoutMs, ["connect"]);
			if (raw === "cli-absent") return { harness: DEFAULT_HARNESS, status: "cli-absent" };
			if (raw === "error") return { harness: DEFAULT_HARNESS, status: "error" };
			const parsed = HarnessConnectResultSchema.safeParse(raw);
			return parsed.success ? parsed.data : { harness: DEFAULT_HARNESS, status: "error" };
		},

		async status(): Promise<HarnessStatusReport> {
			const raw = await runHarnessJson(config, timeoutMs, ["status"]);
			if (raw === "cli-absent" || raw === "error") return { harnesses: [] };
			const parsed = HarnessStatusReportSchema.safeParse(raw);
			return parsed.success ? parsed.data : { harnesses: [] };
		},

		async repair(harness?: string): Promise<HarnessRepairResult> {
			const target = harness ?? DEFAULT_HARNESS;
			const args = harness !== undefined ? ["repair", harness] : ["repair"];
			const raw = await runHarnessJson(config, timeoutMs, args);
			if (raw === "cli-absent") return { harness: target, status: "cli-absent", connected: false };
			if (raw === "error") return { harness: target, status: "error", connected: false };
			const parsed = HarnessRepairResultSchema.safeParse(raw);
			return parsed.success ? parsed.data : { harness: target, status: "error", connected: false };
		},
	};
}
