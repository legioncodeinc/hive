import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LogFileSystem } from "@legioncodeinc/cli-kit";

import { runHiveCli } from "../src/cli-interface.js";
import {
  inspectHiveStatus,
  inspectHiveTelemetry,
  runLogsCommand
} from "../src/cli-observability.js";
import { registerHiveWithDoctor } from "../src/install/registry.js";
import type { ServiceModule } from "../src/service/index.js";
import { resolveHiveStateDir, resolveServiceLogPaths } from "../src/shared/apiary-root.js";

function service(registered: boolean): ServiceModule {
  return {
    install: async () => ({ ok: true, message: "installed" }),
    start: async () => ({ ok: true, message: "started" }),
    stop: async () => ({ ok: true, message: "stopped" }),
    uninstall: async () => ({ ok: true, alreadyAbsent: false, message: "uninstalled" }),
    isRegistered: async () => registered
  };
}

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hive-observability-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("status", () => {
  it("reports installation, live PID, bounded health, Doctor registration, and Hive-owned paths", () => {
    return withTempDir(async (home) => {
      const fleetRoot = { home, env: {}, platform: "linux" as const };
      const registryPath = join(home, ".apiary", "registry.json");
      registerHiveWithDoctor({ registryPath });
      const healthFetch = vi.fn(async () => ({ ok: true, status: 200 }));
      const status = await inspectHiveStatus("/tmp/hive.js", {
        service: service(true),
        fleetRoot,
        registry: { registryPath },
        readPid: () => 4242,
        pidAlive: () => true,
        healthFetch
      });

      expect(status).toMatchObject({
        product: "hive",
        installation: "installed",
        process: { state: "running", pid: 4242 },
        health: { state: "healthy", result: "HTTP 200" },
        registration: "registered",
        paths: {
          config: resolveHiveStateDir(fleetRoot),
          logs: resolveServiceLogPaths(fleetRoot).out
        }
      });
      expect(healthFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("does not probe health for a stopped process and emits JSON through the CLI", async () => {
    const stdout: string[] = [];
    const healthFetch = vi.fn();
    const code = await runHiveCli(["status", "--json"], "/tmp/hive.js", {
      stdout: (text) => stdout.push(text),
      status: {
        service: service(false),
        readPid: () => null,
        healthFetch,
        registry: { registryPath: "/definitely/absent/registry.json" }
      }
    });
    expect(code).toBe(0);
    const body = JSON.parse(stdout.join("")) as { details: { status: Record<string, unknown> } };
    expect(body.details.status).toMatchObject({
      installation: "not-installed",
      process: { state: "stopped" },
      health: { state: "not-applicable" },
      registration: "unregistered"
    });
    expect(healthFetch).not.toHaveBeenCalled();
  });

  it("renders an unhealthy running service in both human and JSON modes", async () => {
    for (const json of [false, true]) {
      const stdout: string[] = [];
      const code = await runHiveCli(["status", ...(json ? ["--json"] : [])], "/tmp/hive.js", {
        stdout: (text) => stdout.push(text),
        status: {
          service: service(true),
          readPid: () => 99,
          pidAlive: () => true,
          healthFetch: async () => ({ ok: false, status: 503 }),
          registry: { registryPath: "/definitely/absent/registry.json" }
        }
      });
      expect(code).toBe(0);
      if (json) expect(JSON.parse(stdout.join("")).details.status.health.state).toBe("unhealthy");
      else expect(stdout.join("")).toContain("Health: unhealthy");
    }
  });
});

describe("telemetry summary", () => {
  it("reports the controlling opt-out setting, disabled destination, and last successful send", () => {
    return withTempDir((home) => {
      const fleetRoot = { home, env: {}, platform: "linux" as const };
      const stateDir = resolveHiveStateDir(fleetRoot);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
        reported: {
          "event:first": "2026-01-01T00:00:00.000Z",
          "event:last": "2026-02-01T00:00:00.000Z"
        }
      }));

      expect(inspectHiveTelemetry({
        fleetRoot,
        env: { HONEYCOMB_TELEMETRY: "0" },
        posthogKey: "phc_present"
      })).toMatchObject({
        state: "opted-out",
        controllingSetting: "HONEYCOMB_TELEMETRY=0",
        destination: "disabled",
        lastSuccessfulSend: "2026-02-01T00:00:00.000Z"
      });
    });
  });

  it("emits a structured, read-only JSON summary", async () => {
    const stdout: string[] = [];
    expect(await runHiveCli(["telemetry", "--json"], "/tmp/hive.js", {
      stdout: (text) => stdout.push(text),
      telemetry: { env: { DO_NOT_TRACK: "1" }, posthogKey: "phc_present" }
    })).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      product: "hive",
      command: "telemetry",
      ok: true,
      details: { telemetry: { state: "opted-out", controllingSetting: "DO_NOT_TRACK" } }
    });
  });

  it("renders telemetry-enabled human output without exposing the destination key", async () => {
    const stdout: string[] = [];
    expect(await runHiveCli(["telemetry"], "/tmp/hive.js", {
      stdout: (text) => stdout.push(text),
      telemetry: { env: {}, posthogKey: "phc_secret_must_not_render" }
    })).toBe(0);
    expect(stdout.join("")).toContain("Telemetry: enabled");
    expect(stdout.join("")).toContain("Destination: hosted");
    expect(stdout.join("")).not.toContain("phc_secret_must_not_render");
  });
});

describe("logs", () => {
  it("reads only the hard-bound Hive service log, honors line limits, and redacts secrets", () => {
    return withTempDir(async (home) => {
      const fleetRoot = { home, env: {}, platform: "linux" as const };
      const expectedRoot = resolveHiveStateDir(fleetRoot);
      const expectedPath = resolveServiceLogPaths(fleetRoot).out;
      const readFile = vi.fn(async (path: string) => {
        expect(path).toBe(expectedPath);
        return "honeycomb should never be read\nhive old\nhive access_token=abc123\n";
      });
      const fs: LogFileSystem = {
        readFile,
        realpath: async (path) => path,
        watch: () => ({ close: () => {} })
      };
      const output: string[] = [];
      expect(await runLogsCommand(["--lines", "1", "--no-follow"], {
        fleetRoot,
        fs,
        out: (text) => output.push(text)
      })).toBe(0);
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(expectedPath.startsWith(expectedRoot)).toBe(true);
      expect(output.join("")).toBe("hive access_token=[REDACTED]\n");
    });
  });

  it("rejects unknown log options with usage exit 2 before reading any file", async () => {
    const readFile = vi.fn(async () => "");
    const output: string[] = [];
    const code = await runLogsCommand(["--product", "honeycomb"], {
      fs: { readFile, realpath: async (path) => path, watch: () => ({ close: () => {} }) },
      out: (text) => output.push(text)
    });
    expect(code).toBe(2);
    expect(readFile).not.toHaveBeenCalled();
    expect(output.join("")).toContain("unknown logs option");
  });

  it("emits missing-log failures on stderr in human mode and one JSON envelope in JSON mode", async () => {
    const fs: LogFileSystem = {
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      realpath: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      watch: () => ({ close: () => {} })
    };
    const humanOut: string[] = [];
    const humanErr: string[] = [];
    expect(await runHiveCli(["logs", "--no-follow"], "/tmp/hive.js", {
      stdout: (text) => humanOut.push(text),
      stderr: (text) => humanErr.push(text),
      logs: { fs }
    })).toBe(1);
    expect(humanOut).toEqual([]);
    expect(humanErr.join("")).toContain("log");

    const jsonOut: string[] = [];
    expect(await runHiveCli(["logs", "--no-follow", "--json"], "/tmp/hive.js", {
      stdout: (text) => jsonOut.push(text),
      stderr: vi.fn(),
      logs: { fs }
    })).toBe(1);
    expect(JSON.parse(jsonOut.join(""))).toMatchObject({ product: "hive", command: "logs", ok: false });
  });
});
