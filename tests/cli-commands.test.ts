import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runDaemonCommand,
  runInstallCommand,
  runInstallServiceCommand,
  runRegisterCommand,
  runRestartCommand,
  runStartCommand,
  runStopCommand,
  runUninstallCommand,
  runUninstallServiceCommand
} from "../src/cli-commands.js";
import { registerHiveWithDoctor } from "../src/install/registry.js";
import type { ServiceModule, ServiceResult, ServiceUninstallResult } from "../src/service/index.js";
import { loadLedger, type EmitDeps, type TelemetryFetch, type TelemetryFetchRequestInit } from "../src/telemetry/emit.js";

interface RecordedPost {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

interface FetchRecorder {
  readonly calls: RecordedPost[];
  readonly fetch: TelemetryFetch;
}

function createFetchRecorder(respond?: () => { ok: boolean; status: number } | Promise<never>): FetchRecorder {
  const calls: RecordedPost[] = [];
  return {
    calls,
    fetch: async (url: string, init: TelemetryFetchRequestInit) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      if (respond !== undefined) return respond();
      return { ok: true, status: 200 };
    }
  };
}

function resolveServiceResult<T>(value: T | (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (value === undefined) return Promise.resolve(fallback);
  return typeof value === "function" ? (value as () => Promise<T>)() : Promise.resolve(value);
}

function createFakeService(
  overrides: {
    install?: ServiceResult | (() => Promise<ServiceResult>);
    start?: ServiceResult | (() => Promise<ServiceResult>);
    stop?: ServiceResult | (() => Promise<ServiceResult>);
    uninstall?: ServiceUninstallResult | (() => Promise<ServiceUninstallResult>);
    isRegistered?: () => Promise<boolean>;
  } = {}
): ServiceModule {
  return {
    install: () => resolveServiceResult(overrides.install, { ok: true, message: "installed" }),
    start: () => resolveServiceResult(overrides.start, { ok: true, message: "started" }),
    stop: () => resolveServiceResult(overrides.stop, { ok: true, message: "stopped" }),
    uninstall: () =>
      resolveServiceResult(overrides.uninstall, { ok: true, alreadyAbsent: false, message: "uninstalled" }),
    isRegistered: overrides.isRegistered ?? (() => Promise.resolve(false))
  };
}

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hive-cli-telemetry-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function telemetryDeps(dir: string, recorder: FetchRecorder, overrides: Partial<EmitDeps> = {}): EmitDeps {
  return {
    posthogKey: "phc_test_key",
    posthogHost: "https://ph.example.test",
    env: {},
    stateDir: join(dir, "state"),
    sharedInstallIdPath: join(dir, "shared-install-id"),
    fetch: recorder.fetch,
    version: "1.0.0",
    ...overrides
  };
}

const silentOut = (): void => {};

describe("install and service-install firing points", () => {
  it("fires hive_installed after a successful full install, once per machine", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = {
        service: createFakeService(),
        registry: { registryPath: join(dir, "doctor.daemons.json") },
        telemetry: telemetryDeps(dir, recorder),
        out: silentOut
      };

      const code = await runInstallCommand("/tmp/cli.js", deps);
      expect(code).toBe(0);
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["hive_installed"]);

      // Re-install on the same machine: the ledger dedupes, no second event.
      const again = await runInstallCommand("/tmp/cli.js", deps);
      expect(again).toBe(0);
      expect(recorder.calls).toHaveLength(1);
    });
  });

  it("does not fire on a failed install and keeps the failure exit code", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const code = await runInstallCommand("/tmp/cli.js", {
        service: createFakeService({ install: { ok: false, message: "boom" } }),
        registry: { registryPath: join(dir, "doctor.daemons.json") },
        telemetry: telemetryDeps(dir, recorder),
        out: silentOut
      });
      expect(code).toBe(1);
      expect(recorder.calls).toHaveLength(0);
    });
  });

  it("a telemetry failure does not change the install exit code", () => {
    return withTempDir(async (dir) => {
      const throwing = createFetchRecorder(() => Promise.reject(new Error("network down")));
      const code = await runInstallCommand("/tmp/cli.js", {
        service: createFakeService(),
        registry: { registryPath: join(dir, "doctor.daemons.json") },
        telemetry: telemetryDeps(dir, throwing),
        out: silentOut
      });
      expect(code).toBe(0);
    });
  });

  it("service-install only reconciles the OS service and emits no lifecycle telemetry", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const code = await runInstallServiceCommand("/tmp/cli.js", {
        service: createFakeService(),
        telemetry: telemetryDeps(dir, recorder),
        out: silentOut
      });
      expect(code).toBe(0);
      expect(recorder.calls).toEqual([]);
    });
  });

});

describe("service-uninstall firing point", () => {
  it("removes only the OS service and emits no lifecycle telemetry", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = {
        service: createFakeService(),
        telemetry: telemetryDeps(dir, recorder),
        out: silentOut
      };
      const code = await runUninstallServiceCommand("/tmp/cli.js", deps);
      expect(code).toBe(0);
      expect(recorder.calls).toEqual([]);

      // A reinstall/uninstall cycle fires it again (no dedupe on uninstall).
      await runUninstallServiceCommand("/tmp/cli.js", deps);
      expect(recorder.calls).toHaveLength(0);
    });
  });

  it("preserves a teardown failure without emitting telemetry", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const code = await runUninstallServiceCommand("/tmp/cli.js", {
        service: createFakeService({
          uninstall: { ok: false, alreadyAbsent: false, message: "deregister failed" }
        }),
        telemetry: telemetryDeps(dir, recorder),
        out: silentOut
      });
      expect(code).toBe(1);
      expect(recorder.calls).toEqual([]);
    });
  });

  it("M-2 treats an already-absent current unit as a friendly no-op (exit 0)", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const code = await runUninstallServiceCommand("/tmp/cli.js", {
        service: createFakeService({
          uninstall: {
            ok: false,
            alreadyAbsent: true,
            message: "hive launchd unit was already absent (nothing to remove)."
          }
        }),
        telemetry: telemetryDeps(dir, recorder),
        out: silentOut
      });
      expect(code).toBe(0);
      expect(recorder.calls).toEqual([]);
    });
  });

  it("a telemetry failure does not change the uninstall exit code", () => {
    return withTempDir(async (dir) => {
      const throwing = createFetchRecorder(() => Promise.reject(new Error("offline")));
      const code = await runUninstallServiceCommand("/tmp/cli.js", {
        service: createFakeService(),
        telemetry: telemetryDeps(dir, throwing),
        out: silentOut
      });
      expect(code).toBe(0);
    });
  });
});

describe("daemon firing points (first_run + updated)", () => {
  interface FakeServer {
    close(callback?: (error?: Error) => void): void;
  }

  function fakeServeFn(): FakeServer {
    return {
      close(callback?: (error?: Error) => void): void {
        callback?.();
      }
    };
  }

  function startDeps(dir: string, recorder: FetchRecorder, telemetryOverrides: Partial<EmitDeps> = {}) {
    return {
      startOptions: {
        serveFn: (() => fakeServeFn()) as never,
        lockPaths: {
          lockFilePath: join(dir, "locks", "hive.lock"),
          pidFilePath: join(dir, "locks", "hive.pid")
        },
        // Home isolation: no test may touch the real fleet root or registry.
        migrateState: () => {},
        registerWithDoctor: () => {}
      },
      telemetry: telemetryDeps(dir, recorder, telemetryOverrides),
      out: silentOut
    };
  }

  it("fires hive_first_run on the first successful start, once per machine", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const code = await runDaemonCommand(startDeps(dir, recorder));
      expect(code).toBe(0);
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["hive_first_run"]);
      expect(loadLedger(join(dir, "state")).lastSeenVersion).toBe("1.0.0");
    });
  });

  it("fires hive_updated when the persisted version differs from the current one", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const first = await runDaemonCommand(startDeps(dir, recorder, { version: "1.0.0" }));
      expect(first).toBe(0);
      rmSync(join(dir, "locks"), { recursive: true, force: true });

      const upgraded = await runDaemonCommand(startDeps(dir, recorder, { version: "1.1.0" }));
      expect(upgraded).toBe(0);
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["hive_first_run", "hive_updated"]);
      expect(loadLedger(join(dir, "state")).lastSeenVersion).toBe("1.1.0");

      // Same version again: nothing further fires.
      rmSync(join(dir, "locks"), { recursive: true, force: true });
      await runDaemonCommand(startDeps(dir, recorder, { version: "1.1.0" }));
      expect(recorder.calls).toHaveLength(2);
    });
  });

  it("a telemetry failure does not change the start exit code", () => {
    return withTempDir(async (dir) => {
      const throwing = createFetchRecorder(() => Promise.reject(new Error("no network")));
      const code = await runDaemonCommand(startDeps(dir, throwing));
      expect(code).toBe(0);
    });
  });
});

describe("register verb", () => {
  it("emits no telemetry at all", () => {
    return withTempDir(async (dir) => {
      const code = await runRegisterCommand({
        registry: { registryPath: join(dir, "doctor.daemons.json") },
        out: silentOut
      });
      expect(code).toBe(0);
      // No telemetry seam exists on this verb by design; nothing to record.
    });
  });
});

describe("stop verb", () => {
  it("b-AC-1 exits 0 with a friendly message when hive is not running", async () => {
    const lines: string[] = [];
    const code = await runStopCommand("/tmp/cli.js", {
      service: createFakeService({ isRegistered: async () => false }),
      pidPath: "/tmp/nonexistent/hive.pid",
      readPid: () => null,
      out: (text) => {
        lines.push(text);
      }
    });
    expect(code).toBe(0);
    expect(lines.join("")).toContain("not running");
  });

  it("b-AC-1 sends SIGTERM to a live pid when no service is registered", async () => {
    const lines: string[] = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const code = await runStopCommand("/tmp/cli.js", {
      service: createFakeService({ isRegistered: async () => false }),
      pidPath: "/tmp/hive.pid",
      readPid: () => 4242,
      isPidAlive: () => alive,
      isOwnedHiveProcess: async () => true,
      kill: (pid, signal) => {
        killed.push({ pid, signal });
        alive = false;
      },
      out: (text) => {
        lines.push(text);
      }
    });
    expect(code).toBe(0);
    expect(killed).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(lines.join("")).toContain("SIGTERM");
  });

  it("converges an orphaned daemon when the service manager reports a successful stop", async () => {
    const lines: string[] = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const code = await runStopCommand("/tmp/cli.js", {
      service: createFakeService({
        isRegistered: async () => true,
        stop: { ok: true, message: "hive service stopped (schtasks)." }
      }),
      pidPath: "/tmp/hive.pid",
      readPid: () => 4242,
      isPidAlive: () => alive,
      isOwnedHiveProcess: async () => true,
      kill: (pid, signal) => {
        killed.push({ pid, signal });
        alive = false;
      },
      out: (text) => lines.push(text)
    });

    expect(code).toBe(0);
    expect(killed).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(lines.join("")).toContain("left the hive daemon running");
  });

  it("rechecks daemon identity after the service-manager stop before signaling", async () => {
    const kill = vi.fn();
    const identity = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const code = await runStopCommand("/tmp/cli.js", {
      service: createFakeService({ isRegistered: async () => true }),
      readPid: () => 4242,
      isPidAlive: () => true,
      isOwnedHiveProcess: identity,
      kill,
      out: silentOut
    });

    expect(code).toBe(1);
    expect(identity).toHaveBeenCalledTimes(2);
    expect(kill).not.toHaveBeenCalled();
  });

  it("fails within the configured bound when an orphan ignores SIGTERM", async () => {
    const kill = vi.fn();
    const delay = vi.fn(async () => {});
    const lines: string[] = [];
    const code = await runStopCommand("/tmp/cli.js", {
      service: createFakeService({ isRegistered: async () => false }),
      readPid: () => 4242,
      isPidAlive: () => true,
      isOwnedHiveProcess: async () => true,
      kill,
      stopAttempts: 3,
      stopDelayMs: 1,
      delay,
      out: (text) => lines.push(text)
    });

    expect(code).toBe(1);
    expect(kill).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledTimes(2);
    expect(lines.join("")).toContain("remained running after SIGTERM");
  });

  it("b-AC-1 stops through the service manager when registered", async () => {
    const lines: string[] = [];
    const code = await runStopCommand("/tmp/cli.js", {
      service: createFakeService({
        isRegistered: async () => true,
        stop: { ok: true, message: "hive service stopped (systemd)." }
      }),
      out: (text) => {
        lines.push(text);
      }
    });
    expect(code).toBe(0);
    expect(lines.join("")).toContain("stopped");
  });

  it("refuses to signal a live pid that does not identify the expected hive daemon", async () => {
    const kill = vi.fn();
    const lines: string[] = [];
    const code = await runStopCommand("/tmp/cli.js", {
      service: createFakeService({ isRegistered: async () => false }),
      readPid: () => 4242,
      isPidAlive: () => true,
      isOwnedHiveProcess: async () => false,
      kill,
      out: (text) => lines.push(text)
    });

    expect(code).toBe(1);
    expect(kill).not.toHaveBeenCalled();
    expect(lines.join("")).toContain("does not identify the expected hive daemon");
  });

  it("AC-9 a genuine stop failure with the daemon still running exits 1 with the error", async () => {
    const lines: string[] = [];
    const code = await runStopCommand("/tmp/cli.js", {
      service: createFakeService({
        isRegistered: async () => true,
        stop: {
          ok: false,
          message: "A service-manager stop command (systemctl) reported an error: Access denied."
        }
      }),
      pidPath: "/tmp/hive.pid",
      readPid: () => 4242,
      isPidAlive: () => true,
      out: (text) => {
        lines.push(text);
      }
    });
    expect(code).toBe(1);
    expect(lines.join("")).toContain("Access denied.");
    expect(lines.join("")).not.toContain("not running");
  });
});

describe("start and restart service verbs", () => {
  it("start delegates to the installed service instead of launching a foreground daemon", async () => {
    const lines: string[] = [];
    const code = await runStartCommand("/tmp/cli.js", {
      service: createFakeService({ start: { ok: true, message: "hive service started (systemd)." } }),
      out: (text) => lines.push(text)
    });
    expect(code).toBe(0);
    expect(lines.join("")).toContain("service started");
  });

  it("restart stops, starts, and succeeds only after bounded health verification", async () => {
    const healthFetch = vi.fn()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const delay = vi.fn(async () => {});
    const code = await runRestartCommand("/tmp/cli.js", {
      service: createFakeService({ isRegistered: async () => true }),
      healthFetch,
      healthAttempts: 3,
      healthDelayMs: 1,
      delay,
      out: silentOut
    });
    expect(code).toBe(0);
    expect(healthFetch).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it("restart terminates a service-manager orphan before starting the replacement", async () => {
    const events: string[] = [];
    let alive = true;
    const service = createFakeService({
      isRegistered: async () => true,
      stop: async () => {
        events.push("service-stop");
        return { ok: true, message: "stopped" };
      },
      start: async () => {
        events.push("service-start");
        return { ok: true, message: "started" };
      }
    });
    const code = await runRestartCommand("/tmp/cli.js", {
      service,
      pidPath: "/tmp/hive.pid",
      readPid: () => 4242,
      isPidAlive: () => alive,
      isOwnedHiveProcess: async () => true,
      kill: () => {
        events.push("sigterm");
        alive = false;
      },
      healthFetch: async () => ({ ok: true, status: 200 }),
      out: silentOut
    });

    expect(code).toBe(0);
    expect(events).toEqual(["service-stop", "sigterm", "service-start"]);
  });

  it("restart never starts a replacement while the prior owned pid remains alive", async () => {
    const start = vi.fn(async () => ({ ok: true, message: "started" }));
    const code = await runRestartCommand("/tmp/cli.js", {
      service: createFakeService({ isRegistered: async () => true, start }),
      readPid: () => 4242,
      isPidAlive: () => true,
      isOwnedHiveProcess: async () => true,
      kill: vi.fn(),
      stopAttempts: 2,
      stopDelayMs: 0,
      delay: async () => {},
      healthFetch: async () => ({ ok: true, status: 200 }),
      out: silentOut
    });

    expect(code).toBe(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("restart fails after the exact configured number of health attempts", async () => {
    const healthFetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const delay = vi.fn(async () => {});
    const lines: string[] = [];
    const code = await runRestartCommand("/tmp/cli.js", {
      service: createFakeService({ isRegistered: async () => true }),
      healthFetch,
      healthAttempts: 3,
      healthDelayMs: 1,
      delay,
      out: (text) => lines.push(text)
    });
    expect(code).toBe(1);
    expect(healthFetch).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(lines.join("")).toContain("did not become healthy");
  });
});

describe("uninstall verb", () => {
  it("b-AC-6 exits 0 when hive is not installed", () => {
    return withTempDir(async (dir) => {
      const home = join(dir, "home");
      const lines: string[] = [];
      const code = await runUninstallCommand("/tmp/cli.js", {
        service: createFakeService({ isRegistered: async () => false }),
        registry: { registryPath: join(dir, "registry.json") },
        fleetRoot: { home },
        stateDirFs: { exists: () => false, lstat: () => ({ isSymbolicLink: () => false }), removeDir: () => {} },
        out: (text) => {
          lines.push(text);
        }
      });
      expect(code).toBe(0);
      expect(lines.join("")).toContain("nothing to remove");
    });
  });

  it("b-AC-2/3/4 runs stop, service removal, registry delete, and state dir removal", () => {
    return withTempDir(async (dir) => {
      const home = join(dir, "home");
      const fleetRoot = join(home, ".apiary");
      const hiveStateDir = join(fleetRoot, "hive");
      const registryPath = join(fleetRoot, "registry.json");
      mkdirSync(hiveStateDir, { recursive: true });
      registerHiveWithDoctor({ registryPath });

      const recorder = createFetchRecorder();
      const lines: string[] = [];
      const removedDirs: string[] = [];
      const code = await runUninstallCommand("/tmp/cli.js", {
        service: createFakeService({
          isRegistered: async () => true,
          stop: { ok: true, message: "stopped" },
          uninstall: { ok: true, alreadyAbsent: false, message: "service unregistered" }
        }),
        registry: { registryPath },
        fleetRoot: { home },
        stateDirFs: {
          exists: (path) => path === hiveStateDir,
          lstat: () => ({ isSymbolicLink: () => false }),
          removeDir: (path) => {
            removedDirs.push(path);
          }
        },
        stop: async () => 0,
        telemetry: telemetryDeps(dir, recorder),
        out: (text) => {
          lines.push(text);
        }
      });

      expect(code).toBe(0);
      expect(removedDirs).toEqual([hiveStateDir]);
      expect(lines.join("")).toContain("Stopped hive daemon.");
      expect(lines.join("")).toContain("Removed hive from doctor registry");
      expect(lines.join("")).toContain("Removed hive state dir.");
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["hive_uninstalled"]);
    });
  });

  it("AC-9 telemetry failure does not change uninstall exit code", () => {
    return withTempDir(async (dir) => {
      const home = join(dir, "home");
      const fleetRoot = join(home, ".apiary");
      const hiveStateDir = join(fleetRoot, "hive");
      mkdirSync(hiveStateDir, { recursive: true });
      const throwing = createFetchRecorder(() => Promise.reject(new Error("offline")));
      const code = await runUninstallCommand("/tmp/cli.js", {
        service: createFakeService({ isRegistered: async () => true }),
        registry: { registryPath: join(fleetRoot, "registry.json") },
        fleetRoot: { home },
        stateDirFs: {
          exists: (path) => path === hiveStateDir,
          lstat: () => ({ isSymbolicLink: () => false }),
          removeDir: () => {}
        },
        stop: async () => 0,
        telemetry: telemetryDeps(dir, throwing),
        out: silentOut
      });
      expect(code).toBe(0);
    });
  });

  it("M-2 macOS stop-then-uninstall sequence exits 0 despite the second bootout failing", () => {
    // Reproduces the finding: `stop` already boot-ed the launchd unit out, so
    // `service.uninstall()`'s own bootout of the current unit finds nothing and
    // is classified `alreadyAbsent: true`. The whole verb must still exit 0.
    return withTempDir(async (dir) => {
      const home = join(dir, "home");
      const fleetRoot = join(home, ".apiary");
      const hiveStateDir = join(fleetRoot, "hive");
      mkdirSync(hiveStateDir, { recursive: true });
      const lines: string[] = [];
      const code = await runUninstallCommand("/tmp/cli.js", {
        service: createFakeService({
          isRegistered: async () => true,
          stop: { ok: true, message: "hive service stopped (launchd)." },
          uninstall: {
            ok: false,
            alreadyAbsent: true,
            message: "hive launchd unit was already absent (nothing to remove)."
          }
        }),
        registry: { registryPath: join(fleetRoot, "registry.json") },
        fleetRoot: { home },
        stateDirFs: {
          exists: (path) => path === hiveStateDir,
          lstat: () => ({ isSymbolicLink: () => false }),
          removeDir: () => {}
        },
        stop: async () => 0,
        out: (text) => {
          lines.push(text);
        }
      });
      expect(code).toBe(0);
      expect(lines.join("")).toContain("already absent");
    });
  });

  it("M-2 a genuine current-unit failure exits nonzero naming the underlying failure", () => {
    return withTempDir(async (dir) => {
      const home = join(dir, "home");
      const fleetRoot = join(home, ".apiary");
      const hiveStateDir = join(fleetRoot, "hive");
      mkdirSync(hiveStateDir, { recursive: true });
      const lines: string[] = [];
      const code = await runUninstallCommand("/tmp/cli.js", {
        service: createFakeService({
          isRegistered: async () => true,
          stop: { ok: true, message: "hive service stopped (systemd)." },
          uninstall: {
            ok: false,
            alreadyAbsent: false,
            message:
              "Removed hive unit file; a deregister command (systemctl) reported an error: Access is denied."
          }
        }),
        registry: { registryPath: join(fleetRoot, "registry.json") },
        fleetRoot: { home },
        stateDirFs: {
          exists: (path) => path === hiveStateDir,
          lstat: () => ({ isSymbolicLink: () => false }),
          removeDir: () => {}
        },
        stop: async () => 0,
        out: (text) => {
          lines.push(text);
        }
      });
      expect(code).toBe(1);
      expect(lines.join("")).toContain("Access is denied.");
      // AC-9: the failure path must not print the contradictory success line.
      expect(lines.join("")).not.toContain("hive uninstalled.\n");
      expect(lines.join("")).toContain("completed with errors");
    });
  });
});
