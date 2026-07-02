import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runInstallServiceCommand,
  runRegisterCommand,
  runStartCommand,
  runUninstallServiceCommand
} from "../src/cli-commands.js";
import type { ServiceModule, ServiceResult } from "../src/service/index.js";
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

function createFakeService(overrides: Partial<Record<"install" | "uninstall", ServiceResult>> = {}): ServiceModule {
  return {
    install: () => Promise.resolve(overrides.install ?? { ok: true, message: "installed" }),
    uninstall: () => Promise.resolve(overrides.uninstall ?? { ok: true, message: "uninstalled" })
  };
}

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thehive-cli-telemetry-test-"));
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

describe("install-service firing point", () => {
  it("fires thehive_installed after a successful install, once per machine", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = {
        service: createFakeService(),
        registry: { registryPath: join(dir, "hivedoctor.daemons.json") },
        telemetry: telemetryDeps(dir, recorder),
        out: silentOut
      };

      const code = await runInstallServiceCommand("/tmp/cli.js", deps);
      expect(code).toBe(0);
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["thehive_installed"]);

      // Re-install on the same machine: the ledger dedupes, no second event.
      const again = await runInstallServiceCommand("/tmp/cli.js", deps);
      expect(again).toBe(0);
      expect(recorder.calls).toHaveLength(1);
    });
  });

  it("does not fire on a failed install and keeps the failure exit code", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const code = await runInstallServiceCommand("/tmp/cli.js", {
        service: createFakeService({ install: { ok: false, message: "boom" } }),
        registry: { registryPath: join(dir, "hivedoctor.daemons.json") },
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
      const code = await runInstallServiceCommand("/tmp/cli.js", {
        service: createFakeService(),
        registry: { registryPath: join(dir, "hivedoctor.daemons.json") },
        telemetry: telemetryDeps(dir, throwing),
        out: silentOut
      });
      expect(code).toBe(0);
    });
  });
});

describe("uninstall-service firing point", () => {
  it("fires thehive_uninstalled (undeduped) and keeps the verb exit code", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = {
        service: createFakeService(),
        telemetry: telemetryDeps(dir, recorder),
        out: silentOut
      };
      const code = await runUninstallServiceCommand("/tmp/cli.js", deps);
      expect(code).toBe(0);
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["thehive_uninstalled"]);

      // A reinstall/uninstall cycle fires it again (no dedupe on uninstall).
      await runUninstallServiceCommand("/tmp/cli.js", deps);
      expect(recorder.calls).toHaveLength(2);
    });
  });

  it("fires even when teardown reports a failure, and the failure code is preserved", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const code = await runUninstallServiceCommand("/tmp/cli.js", {
        service: createFakeService({ uninstall: { ok: false, message: "deregister failed" } }),
        telemetry: telemetryDeps(dir, recorder),
        out: silentOut
      });
      expect(code).toBe(1);
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["thehive_uninstalled"]);
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

describe("start firing points (first_run + updated)", () => {
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
          lockFilePath: join(dir, "locks", "thehive.lock"),
          pidFilePath: join(dir, "locks", "thehive.pid")
        }
      },
      telemetry: telemetryDeps(dir, recorder, telemetryOverrides),
      out: silentOut
    };
  }

  it("fires thehive_first_run on the first successful start, once per machine", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const code = await runStartCommand(startDeps(dir, recorder));
      expect(code).toBe(0);
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["thehive_first_run"]);
      expect(loadLedger(join(dir, "state")).lastSeenVersion).toBe("1.0.0");
    });
  });

  it("fires thehive_updated when the persisted version differs from the current one", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const first = await runStartCommand(startDeps(dir, recorder, { version: "1.0.0" }));
      expect(first).toBe(0);
      rmSync(join(dir, "locks"), { recursive: true, force: true });

      const upgraded = await runStartCommand(startDeps(dir, recorder, { version: "1.1.0" }));
      expect(upgraded).toBe(0);
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["thehive_first_run", "thehive_updated"]);
      expect(loadLedger(join(dir, "state")).lastSeenVersion).toBe("1.1.0");

      // Same version again: nothing further fires.
      rmSync(join(dir, "locks"), { recursive: true, force: true });
      await runStartCommand(startDeps(dir, recorder, { version: "1.1.0" }));
      expect(recorder.calls).toHaveLength(2);
    });
  });

  it("a telemetry failure does not change the start exit code", () => {
    return withTempDir(async (dir) => {
      const throwing = createFetchRecorder(() => Promise.reject(new Error("no network")));
      const code = await runStartCommand(startDeps(dir, throwing));
      expect(code).toBe(0);
    });
  });
});

describe("register verb", () => {
  it("emits no telemetry at all", () => {
    return withTempDir(async (dir) => {
      const code = await runRegisterCommand({
        registry: { registryPath: join(dir, "hivedoctor.daemons.json") },
        out: silentOut
      });
      expect(code).toBe(0);
      // No telemetry seam exists on this verb by design; nothing to record.
    });
  });
});
