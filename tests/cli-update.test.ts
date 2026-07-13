import type { ServiceModule } from "../src/service/index.js";
import {
  runUpdateCommand,
  updateCommandInternals,
  type UpdateExec,
  type UpdateExecResult
} from "../src/cli-update.js";

interface RecordedExec {
  readonly executable: string;
  readonly args: readonly string[];
}

function execSequence(results: readonly UpdateExecResult[]): { readonly calls: RecordedExec[]; readonly exec: UpdateExec } {
  const calls: RecordedExec[] = [];
  let index = 0;
  return {
    calls,
    exec: async (executable, args) => {
      calls.push({ executable, args: [...args] });
      const result = results[index++];
      if (result === undefined) throw new Error("unexpected updater invocation");
      return result;
    }
  };
}

function ok(stdout = ""): UpdateExecResult {
  return { ok: true, stdout, stderr: "" };
}

function failed(stderr = "failed"): UpdateExecResult {
  return { ok: false, stdout: "", stderr };
}

function recordingService(registered = true) {
  const calls: string[] = [];
  const service: ServiceModule = {
    install: async () => ({ ok: true, message: "installed" }),
    start: async () => { calls.push("start"); return { ok: true, message: "started" }; },
    stop: async () => { calls.push("stop"); return { ok: true, message: "stopped" }; },
    uninstall: async () => ({ ok: true, alreadyAbsent: false, message: "uninstalled" }),
    isRegistered: async () => { calls.push("isRegistered"); return registered; }
  };
  return { calls, service };
}

describe("Hive approved-channel updater", () => {
  it("uses fixed argv for lookup and exact-version global install without a shell", async () => {
    const runner = execSequence([ok('"1.2.0"'), ok()]);
    const service = recordingService(false);
    const lines: string[] = [];
    expect(await runUpdateCommand("/tmp/hive.js", {
      installedVersion: "1.1.0",
      platform: "linux",
      exec: runner.exec,
      service: service.service,
      out: (text) => lines.push(text)
    })).toBe(0);
    expect(runner.calls).toEqual([
      { executable: "npm", args: ["view", "@legioncodeinc/hive", "version", "--json"] },
      { executable: "npm", args: ["install", "--global", "@legioncodeinc/hive@1.2.0"] }
    ]);
    expect(service.calls).toEqual(["isRegistered"]);
    expect(lines.join("")).toContain("state was preserved");
  });

  it("is an idempotent no-op when the approved version is installed", async () => {
    const runner = execSequence([ok("1.1.0\n")]);
    const service = recordingService();
    expect(await runUpdateCommand("/tmp/hive.js", {
      installedVersion: "1.1.0",
      exec: runner.exec,
      service: service.service,
      out: vi.fn()
    })).toBe(0);
    expect(runner.calls).toHaveLength(1);
    expect(service.calls).toEqual([]);
  });

  it("rejects an unapproved version-shaped injection before executing install", async () => {
    const runner = execSequence([ok('"1.2.0 && whoami"')]);
    expect(await runUpdateCommand("/tmp/hive.js", {
      installedVersion: "1.1.0",
      exec: runner.exec,
      out: vi.fn()
    })).toBe(1);
    expect(runner.calls).toHaveLength(1);
  });

  it("restarts the prior installed service when the package update itself fails", async () => {
    const runner = execSequence([ok('"1.2.0"'), failed()]);
    const service = recordingService();
    expect(await runUpdateCommand("/tmp/hive.js", {
      installedVersion: "1.1.0",
      exec: runner.exec,
      service: service.service,
      out: vi.fn()
    })).toBe(1);
    expect(service.calls).toEqual(["isRegistered", "stop", "start"]);
    expect(runner.calls[1]?.args).toEqual(["install", "--global", "@legioncodeinc/hive@1.2.0"]);
  });

  it("rolls back with fixed argv when post-update health fails, then verifies recovery", async () => {
    const runner = execSequence([ok('"1.2.0"'), ok(), ok()]);
    const service = recordingService();
    const healthFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const lines: string[] = [];
    expect(await runUpdateCommand("/tmp/hive.js", {
      installedVersion: "1.1.0",
      platform: "win32",
      exec: runner.exec,
      service: service.service,
      healthFetch,
      healthAttempts: 1,
      out: (text) => lines.push(text)
    })).toBe(1);
    expect(runner.calls).toEqual([
      { executable: "npm.cmd", args: ["view", "@legioncodeinc/hive", "version", "--json"] },
      { executable: "npm.cmd", args: ["install", "--global", "@legioncodeinc/hive@1.2.0"] },
      { executable: "npm.cmd", args: ["install", "--global", "@legioncodeinc/hive@1.1.0"] }
    ]);
    expect(service.calls).toEqual(["isRegistered", "stop", "start", "stop", "start"]);
    expect(healthFetch).toHaveBeenCalledTimes(2);
    expect(lines.join("")).toContain("Rollback to 1.1.0 completed");
  });

  it("reports manual repair when rollback cannot be installed", async () => {
    const runner = execSequence([ok('"1.2.0"'), ok(), failed("registry unavailable")]);
    const service = recordingService();
    const lines: string[] = [];
    expect(await runUpdateCommand("/tmp/hive.js", {
      installedVersion: "1.1.0",
      exec: runner.exec,
      service: service.service,
      healthFetch: async () => ({ ok: false, status: 503 }),
      healthAttempts: 1,
      out: (text) => lines.push(text)
    })).toBe(1);
    expect(service.calls).toEqual(["isRegistered", "stop", "start", "stop"]);
    expect(lines.join("")).toContain("manual repair is required");
  });

  it("accepts semver releases and rejects shell tokens in parsed npm output", () => {
    expect(updateCommandInternals.parseApprovedVersion('"2.0.0-beta.1"')).toBe("2.0.0-beta.1");
    expect(updateCommandInternals.parseApprovedVersion("2.0.0;rm -rf /")).toBeNull();
    expect(updateCommandInternals.npmExecutable("win32")).toBe("npm.cmd");
    expect(updateCommandInternals.npmExecutable("darwin")).toBe("npm");
  });
});
