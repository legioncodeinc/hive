import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALLOWED_PROPERTY_KEYS,
  DEFAULT_EMIT_TIMEOUT_MS,
  INSTALL_ID_FILENAME,
  LEDGER_FILENAME,
  buildAllowedProperties,
  captureUrl,
  emitInstalled,
  emitTelemetry,
  emitUninstalled,
  isOptedOut,
  loadLedger,
  recordStartLifecycle,
  resolveDistinctId,
  type EmitDeps,
  type TelemetryFetch,
  type TelemetryFetchRequestInit
} from "../../src/telemetry/emit.js";

interface RecordedPost {
  readonly url: string;
  readonly init: TelemetryFetchRequestInit;
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
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
      if (respond !== undefined) return respond();
      return { ok: true, status: 200 };
    }
  };
}

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thehive-telemetry-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Baseline keyed deps pointing every filesystem seam at the temp dir and isolating the env. */
function keyedDeps(dir: string, recorder: FetchRecorder, overrides: Partial<EmitDeps> = {}): EmitDeps {
  return {
    posthogKey: "phc_test_key",
    posthogHost: "https://ph.example.test",
    env: {},
    stateDir: join(dir, "state"),
    sharedInstallIdPath: join(dir, "shared-install-id"),
    fetch: recorder.fetch,
    version: "1.2.3",
    ...overrides
  };
}

describe("telemetry chokepoint gates", () => {
  it("empty build key hard-disables: no network, no state dir created", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder, { posthogKey: "" });
      const outcome = await emitTelemetry("thehive_installed", { dedupeKey: "thehive_installed" }, deps);
      expect(outcome.sent).toBe(false);
      expect(outcome.skipped).toBe("disabled");
      expect(recorder.calls).toHaveLength(0);
      expect(existsSync(join(dir, "state"))).toBe(false);
    });
  });

  it("HONEYCOMB_TELEMETRY=0 opts out before any IO or network", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder, { env: { HONEYCOMB_TELEMETRY: "0" } });
      const outcome = await emitTelemetry("thehive_first_run", {}, deps);
      expect(outcome).toMatchObject({ sent: false, skipped: "opted_out" });
      expect(recorder.calls).toHaveLength(0);
      expect(existsSync(join(dir, "state"))).toBe(false);
    });
  });

  it("DO_NOT_TRACK truthy opts out; empty or 0 does not", () => {
    expect(isOptedOut({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(isOptedOut({ DO_NOT_TRACK: "true" })).toBe(true);
    expect(isOptedOut({ DO_NOT_TRACK: "0" })).toBe(false);
    expect(isOptedOut({ DO_NOT_TRACK: "" })).toBe(false);
    expect(isOptedOut({})).toBe(false);
    expect(isOptedOut({ HONEYCOMB_TELEMETRY: "0" })).toBe(true);
    expect(isOptedOut({ HONEYCOMB_TELEMETRY: "1" })).toBe(false);
  });

  it("DO_NOT_TRACK=1 blocks the send through emitTelemetry", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder, { env: { DO_NOT_TRACK: "1" } });
      const outcome = await emitTelemetry("thehive_updated", {}, deps);
      expect(outcome).toMatchObject({ sent: false, skipped: "opted_out" });
      expect(recorder.calls).toHaveLength(0);
    });
  });
});

describe("telemetry payload shape", () => {
  it("posts exactly {api_key, event, properties, distinct_id} to {host}/i/v0/e/", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder);
      const outcome = await emitTelemetry("thehive_installed", {}, deps);
      expect(outcome.sent).toBe(true);

      expect(recorder.calls).toHaveLength(1);
      const call = recorder.calls[0];
      expect(call.url).toBe("https://ph.example.test/i/v0/e/");
      expect(call.init.method).toBe("POST");
      expect(call.init.headers["Content-Type"]).toBe("application/json");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(Object.keys(call.body).sort()).toEqual(["api_key", "distinct_id", "event", "properties"]);
      expect(call.body["api_key"]).toBe("phc_test_key");
      expect(call.body["event"]).toBe("thehive_installed");
    });
  });

  it("properties carry exactly the closed allow-list {package, version, os, arch, node}", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      await emitTelemetry("thehive_first_run", {}, keyedDeps(dir, recorder));
      const properties = recorder.calls[0].body["properties"] as Record<string, string>;
      expect(Object.keys(properties).sort()).toEqual([...ALLOWED_PROPERTY_KEYS].sort());
      expect(properties["package"]).toBe("thehive");
      expect(properties["version"]).toBe("1.2.3");
      expect(properties["os"]).toBe(process.platform);
      expect(properties["node"]).toBe(process.version);
    });
  });

  it("buildAllowedProperties never carries a hostname, path, or free-form field", () => {
    const properties = buildAllowedProperties("9.9.9");
    expect(Object.keys(properties).sort()).toEqual([...ALLOWED_PROPERTY_KEYS].sort());
    const serialized = JSON.stringify(properties);
    expect(serialized).not.toContain(tmpdir());
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("email");
  });

  it("captureUrl tolerates a trailing slash on the host", () => {
    expect(captureUrl("https://ph.example.test/")).toBe("https://ph.example.test/i/v0/e/");
    expect(DEFAULT_EMIT_TIMEOUT_MS).toBe(2000);
  });
});

describe("distinct_id preference", () => {
  it("prefers the shared ~/.honeycomb/install-id file when present", () => {
    return withTempDir(async (dir) => {
      const sharedPath = join(dir, "shared-install-id");
      writeFileSync(sharedPath, "shared-funnel-id-123\n", "utf8");
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder, { sharedInstallIdPath: sharedPath });
      await emitTelemetry("thehive_installed", {}, deps);
      expect(recorder.calls[0].body["distinct_id"]).toBe("shared-funnel-id-123");
      // No fallback id gets generated when the shared one exists.
      expect(existsSync(join(dir, "state", INSTALL_ID_FILENAME))).toBe(false);
    });
  });

  it("generates a UUID and persists it in the state dir when no shared id exists", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder);
      await emitTelemetry("thehive_installed", {}, deps);

      const sentId = recorder.calls[0].body["distinct_id"] as string;
      expect(sentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const persisted = readFileSync(join(dir, "state", INSTALL_ID_FILENAME), "utf8").trim();
      expect(persisted).toBe(sentId);
    });
  });

  it("reuses the persisted generated id on subsequent emits", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder);
      const first = resolveDistinctId(deps);
      const second = resolveDistinctId(deps);
      expect(second).toBe(first);
      await emitTelemetry("thehive_uninstalled", {}, deps);
      expect(recorder.calls[0].body["distinct_id"]).toBe(first);
    });
  });
});

describe("dedupe ledger", () => {
  it("a deduped event sends at most once per machine", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder);
      const first = await emitInstalled(deps);
      const second = await emitInstalled(deps);
      expect(first.sent).toBe(true);
      expect(second).toMatchObject({ sent: false, skipped: "already_reported" });
      expect(recorder.calls).toHaveLength(1);

      const ledger = loadLedger(join(dir, "state"));
      expect(Object.keys(ledger.reported)).toEqual(["thehive_installed"]);
    });
  });

  it("an undeduped event (uninstalled) fires every time", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder);
      await emitUninstalled(deps);
      await emitUninstalled(deps);
      expect(recorder.calls).toHaveLength(2);
      expect(recorder.calls.every((call) => call.body["event"] === "thehive_uninstalled")).toBe(true);
    });
  });

  it("a failed send is NOT recorded in the ledger, so the next attempt retries", () => {
    return withTempDir(async (dir) => {
      const failing = createFetchRecorder(() => ({ ok: false, status: 500 }));
      const deps = keyedDeps(dir, failing);
      const outcome = await emitInstalled(deps);
      expect(outcome).toMatchObject({ sent: false, skipped: "send_failed" });

      const recorder = createFetchRecorder();
      const retried = await emitInstalled({ ...deps, fetch: recorder.fetch });
      expect(retried.sent).toBe(true);
      expect(recorder.calls).toHaveLength(1);
    });
  });

  it("a corrupt ledger file is treated as empty (fail-soft), never a throw", () => {
    return withTempDir(async (dir) => {
      const stateDir = join(dir, "state");
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder);
      await emitInstalled(deps);
      writeFileSync(join(stateDir, LEDGER_FILENAME), "{not json", "utf8");
      const outcome = await emitInstalled(deps);
      // The corrupt ledger reads as empty, so the event legitimately re-sends.
      expect(outcome.sent).toBe(true);
    });
  });
});

describe("fail-soft posture", () => {
  it("a throwing fetch resolves send_failed and never rejects", () => {
    return withTempDir(async (dir) => {
      const throwing = createFetchRecorder(() => Promise.reject(new Error("network down")));
      const outcome = await emitTelemetry("thehive_installed", { dedupeKey: "thehive_installed" }, keyedDeps(dir, throwing));
      expect(outcome).toMatchObject({ sent: false, skipped: "send_failed" });
    });
  });

  it("a non-2xx response resolves send_failed", () => {
    return withTempDir(async (dir) => {
      const rejecting = createFetchRecorder(() => ({ ok: false, status: 400 }));
      const outcome = await emitTelemetry("thehive_first_run", {}, keyedDeps(dir, rejecting));
      expect(outcome).toMatchObject({ sent: false, skipped: "send_failed" });
    });
  });

  it("an unwritable state dir still resolves (ledger persist is best-effort)", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      // Point the state dir AT A FILE so mkdir/read/write all fail.
      const bogusStateDir = join(dir, "not-a-dir");
      writeFileSync(bogusStateDir, "occupied", "utf8");
      const deps = keyedDeps(dir, recorder, { stateDir: bogusStateDir });
      const outcome = await emitInstalled(deps);
      // The send itself still goes out; only the bookkeeping degrades.
      expect(outcome.sent).toBe(true);
      expect(recorder.calls).toHaveLength(1);
    });
  });
});

describe("recordStartLifecycle (first_run + updated)", () => {
  it("first start emits thehive_first_run once and pins lastSeenVersion, no updated event", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const deps = keyedDeps(dir, recorder, { version: "1.0.0" });

      const outcome = await recordStartLifecycle(deps);
      expect(outcome.firstRun.sent).toBe(true);
      expect(outcome.updated).toBeNull();
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["thehive_first_run"]);
      expect(loadLedger(join(dir, "state")).lastSeenVersion).toBe("1.0.0");

      const again = await recordStartLifecycle(deps);
      expect(again.firstRun).toMatchObject({ sent: false, skipped: "already_reported" });
      expect(again.updated).toBeNull();
      expect(recorder.calls).toHaveLength(1);
    });
  });

  it("a version change on start emits thehive_updated once per version and advances lastSeenVersion", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      await recordStartLifecycle(keyedDeps(dir, recorder, { version: "1.0.0" }));

      // Simulate an npm reinstall to 1.1.0.
      const upgraded = keyedDeps(dir, recorder, { version: "1.1.0" });
      const outcome = await recordStartLifecycle(upgraded);
      expect(outcome.updated?.sent).toBe(true);
      expect(recorder.calls.map((call) => call.body["event"])).toEqual(["thehive_first_run", "thehive_updated"]);
      expect(recorder.calls[1].body["properties"]).toMatchObject({ version: "1.1.0" });

      const ledger = loadLedger(join(dir, "state"));
      expect(ledger.lastSeenVersion).toBe("1.1.0");
      expect(Object.keys(ledger.reported)).toContain("thehive_updated@1.1.0");

      // The same version starting again emits nothing further.
      const rerun = await recordStartLifecycle(upgraded);
      expect(rerun.updated).toBeNull();
      expect(recorder.calls).toHaveLength(2);
    });
  });

  it("a failed updated send leaves lastSeenVersion untouched so the next start retries", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      await recordStartLifecycle(keyedDeps(dir, recorder, { version: "1.0.0" }));

      const failing = createFetchRecorder(() => Promise.reject(new Error("offline")));
      const outcome = await recordStartLifecycle(keyedDeps(dir, failing, { version: "1.1.0" }));
      expect(outcome.updated).toMatchObject({ sent: false, skipped: "send_failed" });
      expect(loadLedger(join(dir, "state")).lastSeenVersion).toBe("1.0.0");

      const retried = await recordStartLifecycle(keyedDeps(dir, recorder, { version: "1.1.0" }));
      expect(retried.updated?.sent).toBe(true);
      expect(loadLedger(join(dir, "state")).lastSeenVersion).toBe("1.1.0");
    });
  });

  it("disabled or opted-out starts do no bookkeeping at all", () => {
    return withTempDir(async (dir) => {
      const recorder = createFetchRecorder();
      const disabled = await recordStartLifecycle(keyedDeps(dir, recorder, { posthogKey: "" }));
      expect(disabled.firstRun.skipped).toBe("disabled");
      expect(disabled.updated).toBeNull();

      const optedOut = await recordStartLifecycle(keyedDeps(dir, recorder, { env: { DO_NOT_TRACK: "1" } }));
      expect(optedOut.firstRun.skipped).toBe("opted_out");

      expect(recorder.calls).toHaveLength(0);
      expect(existsSync(join(dir, "state"))).toBe(false);
    });
  });
});
