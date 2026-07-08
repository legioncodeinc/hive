/**
 * PRD-006c/006d: the hive-side honeycomb harness-connect CLI client. Verifies the argv-safe shell
 * (resolved `*.js` entry, `harness <sub> --json`), the status mapping from honeycomb's JSON shapes,
 * and the FAIL-SOFT contract (absent bin / spawn throw / timeout / non-JSON all degrade to a clean
 * status, never a throw). Every seam is faked so no real honeycomb binary or filesystem is touched.
 */

import { join } from "node:path";

import { createHoneycombCli, HONEYCOMB_PACKAGE, type HoneycombCliOptions } from "../../../src/daemon/harness/honeycomb-cli.js";
import { globalNodeModulesDir } from "../../../src/daemon/installer/bin-resolver.js";
import type { SpawnFn, SpawnOutcome } from "../../../src/daemon/installer/spawn.js";

const PREFIX = "/fake/prefix";
const NODE = "/fake/node";

function packageDir(): string {
	return join(globalNodeModulesDir(PREFIX, process.platform), HONEYCOMB_PACKAGE);
}
const PKG_JSON = join(packageDir(), "package.json");
const CLI_JS = join(packageDir(), "dist/cli.js");

interface SpawnCall {
	readonly command: string;
	readonly args: readonly string[];
}

/** A spawn that records its calls and returns a scripted terminal outcome. */
function recordingSpawn(outcome: SpawnOutcome | (() => Promise<SpawnOutcome>)): { fn: SpawnFn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const fn: SpawnFn = (command, args) => {
		calls.push({ command, args: [...args] });
		return typeof outcome === "function" ? outcome() : Promise.resolve(outcome);
	};
	return { fn, calls };
}

function ok(stdoutTail: string): SpawnOutcome {
	return { code: 0, stdoutTail, stderrTail: "" };
}

/** Build the client over faked seams; by default the honeycomb bin resolves cleanly. */
function makeCli(spawn: SpawnFn, overrides: Partial<HoneycombCliOptions> = {}) {
	const files = new Map<string, string>();
	files.set(PKG_JSON, JSON.stringify({ bin: { honeycomb: "dist/cli.js" } }));
	files.set(CLI_JS, "// entry");
	return createHoneycombCli({
		execPath: NODE,
		platform: process.platform,
		fileExists: (p) => files.has(p),
		readTextFile: (p) => files.get(p) ?? null,
		resolveNpmPrefix: async () => PREFIX,
		spawn,
		requireResolve: () => null,
		...overrides,
	});
}

describe("honeycomb-cli client", () => {
	it("connect: shells `harness connect --json` argv-safe and maps the connected status", async () => {
		const spawn = recordingSpawn(ok(JSON.stringify({ harness: "claude-code", status: "connected" })));
		const cli = makeCli(spawn.fn);

		const result = await cli.connect();

		expect(result).toEqual({ harness: "claude-code", status: "connected" });
		expect(spawn.calls).toHaveLength(1);
		expect(spawn.calls[0]?.command).toBe(NODE);
		expect(spawn.calls[0]?.args).toEqual([CLI_JS, "harness", "connect", "--json"]);
	});

	it("connect: carries through agent-absent + a detail", async () => {
		const spawn = recordingSpawn(ok(JSON.stringify({ harness: "claude-code", status: "agent-absent", detail: "not installed" })));
		const result = await makeCli(spawn.fn).connect();
		expect(result).toEqual({ harness: "claude-code", status: "agent-absent", detail: "not installed" });
	});

	it("status: parses the per-harness connection report", async () => {
		const report = {
			harnesses: [
				{ harness: "claude-code", agentPresent: true, pluginEnabled: true, connected: true, lastOutcome: "already-enabled" },
				{ harness: "codex", agentPresent: true, pluginEnabled: false, connected: false },
			],
		};
		const spawn = recordingSpawn(ok(JSON.stringify(report)));
		const result = await makeCli(spawn.fn).status();
		expect(result.harnesses).toHaveLength(2);
		expect(result.harnesses[0]).toMatchObject({ harness: "claude-code", pluginEnabled: true, connected: true, lastOutcome: "already-enabled" });
		expect(spawn.calls[0]?.args).toEqual([CLI_JS, "harness", "status", "--json"]);
	});

	it("repair: passes the named harness and maps the updated status", async () => {
		const spawn = recordingSpawn(ok(JSON.stringify({ harness: "codex", status: "connected", connected: true })));
		const result = await makeCli(spawn.fn).repair("codex");
		expect(result).toEqual({ harness: "codex", status: "connected", connected: true });
		expect(spawn.calls[0]?.args).toEqual([CLI_JS, "harness", "repair", "codex", "--json"]);
	});

	it("repair: omits the harness arg when none is given (default target)", async () => {
		const spawn = recordingSpawn(ok(JSON.stringify({ harness: "claude-code", status: "connected", connected: true })));
		await makeCli(spawn.fn).repair();
		expect(spawn.calls[0]?.args).toEqual([CLI_JS, "harness", "repair", "--json"]);
	});

	it("repair: a flag-shaped harness is rejected fail-soft and NEVER reaches the spawn argv", async () => {
		const spawn = recordingSpawn(ok(JSON.stringify({ harness: "x", status: "connected", connected: true })));
		const cli = makeCli(spawn.fn);
		for (const evil of ["--config=/etc/passwd", "-h", "--json", "a b", "a/b", "a;b", "--"]) {
			const result = await cli.repair(evil);
			expect(result).toEqual({ harness: "claude-code", status: "error", connected: false });
		}
		expect(spawn.calls).toHaveLength(0);
	});

	it("tolerates a leading log line before the JSON blob", async () => {
		const spawn = recordingSpawn(ok(`booting honeycomb...\n${JSON.stringify({ harness: "claude-code", status: "connected" })}`));
		const result = await makeCli(spawn.fn).connect();
		expect(result.status).toBe("connected");
	});

	it("fail-soft: an unresolvable bin (no npm prefix) degrades to cli-absent, never a spawn", async () => {
		const spawn = recordingSpawn(ok("{}"));
		const cli = makeCli(spawn.fn, { resolveNpmPrefix: async () => null });

		expect(await cli.connect()).toEqual({ harness: "claude-code", status: "cli-absent" });
		expect((await cli.status()).harnesses).toEqual([]);
		expect(await cli.repair()).toEqual({ harness: "claude-code", status: "cli-absent", connected: false });
		expect(spawn.calls).toHaveLength(0);
	});

	it("fail-soft: a spawn throw degrades to error (never rejects)", async () => {
		const throwingSpawn: SpawnFn = () => Promise.reject(new Error("ENOENT"));
		const cli = makeCli(throwingSpawn);
		expect(await cli.connect()).toEqual({ harness: "claude-code", status: "error" });
		expect(await cli.repair("codex")).toEqual({ harness: "codex", status: "error", connected: false });
	});

	it("fail-soft: a non-JSON stdout degrades to error", async () => {
		const spawn = recordingSpawn(ok("the status surface is not wired in this build"));
		expect((await makeCli(spawn.fn).connect()).status).toBe("error");
	});

	it("fail-soft: a malformed JSON body (wrong shape) degrades to error", async () => {
		const spawn = recordingSpawn(ok(JSON.stringify({ harness: "claude-code", status: "bogus-status" })));
		expect((await makeCli(spawn.fn).connect()).status).toBe("error");
	});
});
