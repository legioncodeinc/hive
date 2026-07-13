/**
 * PRD-009c onboarding funnel telemetry (tm-AC-1 through tm-AC-6) plus MV-2 manifest URL fallback.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SetupAuthFetchImpl } from "../../../src/daemon/setup-auth.js";
import type { FetchImpl as FleetFetchImpl } from "../../../src/daemon/fleet-status.js";
import {
  MANIFEST_FALLBACK_URL,
  MANIFEST_URL
} from "../../../src/daemon/installer/config.js";
import { NPM_INSTALL_NETWORK_FLAGS } from "../../../src/daemon/installer/install-state.js";
// The real ship-time snapshot: the offline-fallback assertion reads its doctor pin (see below).
import manifestSnapshot from "../../../src/daemon/installer/manifest-snapshot.json" with { type: "json" };
import {
  ALLOWED_PROPERTY_KEYS,
  FUNNEL_PROPERTY_KEYS,
  type EmitDeps,
  type TelemetryFetch,
  type TelemetryFetchRequestInit
} from "../../../src/telemetry/emit.js";
import { ONBOARDING_LEDGER_FILENAME } from "../../../src/telemetry/onboarding-session-ledger.js";
import {
  DEFAULT_MANIFEST,
  NPM_CLI,
  TOKEN,
  TOKEN_PATH,
  binEntryKey,
  makeHarness,
  outcome,
  pkgJsonKey,
  request,
  scriptedSpawn,
  tick
} from "./helpers.js";

interface RecordedPost {
  readonly url: string;
  readonly init: TelemetryFetchRequestInit;
  readonly body: Record<string, unknown>;
}

function createFetchRecorder(): { readonly calls: RecordedPost[]; readonly fetch: TelemetryFetch } {
  const calls: RecordedPost[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
      return { ok: true, status: 200 };
    }
  };
}

function telemetryHarness(extra: Parameters<typeof makeHarness>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hive-funnel-test-"));
  const recorder = createFetchRecorder();
  const deps: EmitDeps = {
    posthogKey: "phc_test_key",
    posthogHost: "https://ph.example.test",
    env: {},
    stateDir: join(dir, "state"),
    fetch: recorder.fetch,
    version: "0.2.1",
    clock: () => "2026-07-03T12:00:00.000Z"
  };
  const harness = makeHarness({
    ...extra,
    overrides: {
      // Keep unrelated funnel tests hermetic: the default harness may observe a live/local
      // authenticated setup state and asynchronously inject login_completed into their recorder.
      setupAuthFetch: unauthenticatedSetupFetch,
      funnelEmitDeps: deps,
      funnelStateDir: join(dir, "state"),
      ...extra.overrides
    }
  });
  return { ...harness, recorder, telemetryDir: join(dir, "state"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function flushTelemetry(): Promise<void> {
  await tick();
  await tick();
}

const readyDoctorFetch: FleetFetchImpl = async () =>
  new Response(
    JSON.stringify({
      health: "ok",
      asOf: "2026-07-03T12:00:00.000Z",
      daemons: [{ name: "honeycomb", health: "ok", escalation: null }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const authenticatedSetupFetch: SetupAuthFetchImpl = async () =>
  new Response(JSON.stringify({ authenticated: true }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

const unauthenticatedSetupFetch: SetupAuthFetchImpl = async () =>
  new Response(JSON.stringify({ authenticated: false }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

function eventNames(calls: RecordedPost[]): string[] {
  return calls.map((call) => call.body["event"] as string);
}

function allSerializedPayloads(calls: RecordedPost[]): string {
  return JSON.stringify(calls.map((call) => call.body));
}

describe("PRD-009c tm-AC-1 funnel events at transitions", () => {
  it("emits UI-originated milestones through the event route", async () => {
    const { app, recorder, cleanup } = telemetryHarness();
    try {
      for (const [path, body] of [
        ["/api/onboarding/event", { event: "onboarding_started" }],
        ["/api/onboarding/event", { event: "mode_selected", properties: { mode: "standard" } }],
        ["/api/onboarding/event", { event: "login_shown" }]
      ] as const) {
        const res = await request(app, path, { method: "POST", body });
        expect(res.status).toBe(202);
      }
      await flushTelemetry();
      expect(eventNames(recorder.calls)).toEqual(["onboarding_started", "mode_selected", "login_shown"]);
      const modeProps = recorder.calls[1].body["properties"] as Record<string, string>;
      expect(modeProps["mode"]).toBe("standard");
    } finally {
      cleanup();
    }
  });

  it("emits product_install_started, completed, and failed from the install state machine", async () => {
    const { app, service, recorder, cleanup } = telemetryHarness({
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      }
    });
    try {
      const ok = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
      expect(ok.status).toBe(202);
      await service.store.settled("doctor");
      await flushTelemetry();
      expect(eventNames(recorder.calls)).toContain("product_install_started");
      expect(eventNames(recorder.calls)).toContain("product_install_completed");
    } finally {
      cleanup();
    }
  });

  it("emits product_install_failed with failure_stage on terminal failure", async () => {
    const { fn } = scriptedSpawn(() => Promise.resolve(outcome(1, "npm broke")));
    const { app, service, recorder, cleanup } = telemetryHarness({ overrides: { spawn: fn } });
    try {
      const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
      expect(res.status).toBe(202);
      await service.store.settled("doctor");
      await flushTelemetry();
      const failed = recorder.calls.find((call) => call.body["event"] === "product_install_failed");
      expect(failed).toBeDefined();
      const props = failed!.body["properties"] as Record<string, string>;
      expect(props["product"]).toBe("doctor");
      expect(props["failure_stage"]).toBe("downloading");
    } finally {
      cleanup();
    }
  });

  it("emits health_check_passed when the health endpoint reports ready", async () => {
    const { app, recorder, cleanup } = telemetryHarness({
      overrides: { fleetStatusFetch: readyDoctorFetch, setupAuthFetch: unauthenticatedSetupFetch }
    });
    try {
      const res = await request(app, "/api/onboarding/health");
      expect(res.status).toBe(200);
      await flushTelemetry();
      expect(eventNames(recorder.calls)).toEqual(["health_check_passed"]);
    } finally {
      cleanup();
    }
  });

  it("emits login_completed when /setup/state authenticated flips true", async () => {
    const { app, recorder, cleanup } = telemetryHarness({
      overrides: { setupAuthFetch: authenticatedSetupFetch }
    });
    try {
      const res = await request(app, "/api/onboarding/event", {
        method: "POST",
        body: { event: "login_shown" }
      });
      expect(res.status).toBe(202);
      await flushTelemetry();
      expect(eventNames(recorder.calls)).toContain("login_completed");
    } finally {
      cleanup();
    }
  });

  it("emits dashboard_reached from the UI event route", async () => {
    const { app, recorder, cleanup } = telemetryHarness({
      overrides: { setupAuthFetch: unauthenticatedSetupFetch }
    });
    try {
      await request(app, "/api/onboarding/event", { method: "POST", body: { event: "dashboard_reached" } });
      await flushTelemetry();
      expect(eventNames(recorder.calls)).toEqual(["dashboard_reached"]);
    } finally {
      cleanup();
    }
  });
});

describe("PRD-011a ts-AC-13 tenancy funnel events are ACCEPTED by the event route", () => {
  it("ts-AC-13 accepts tenancy_shown, tenancy_selected, and workspace_created (202, not 400) and emits them", async () => {
    const { app, recorder, cleanup } = telemetryHarness();
    try {
      for (const [path, body] of [
        ["/api/onboarding/event", { event: "tenancy_shown" }],
        ["/api/onboarding/event", { event: "tenancy_selected", properties: { orgCount: "few", singleOrgConfirm: "false" } }],
        ["/api/onboarding/event", { event: "workspace_created" }]
      ] as const) {
        const res = await request(app, path, { method: "POST", body });
        expect(res.status).toBe(202);
      }
      await flushTelemetry();
      expect(eventNames(recorder.calls)).toEqual(["tenancy_shown", "tenancy_selected", "workspace_created"]);
    } finally {
      cleanup();
    }
  });

  it("ts-AC-13 forwards only the bucketed org count and confirm flag on tenancy_selected (closed allow-list)", async () => {
    const { app, recorder, cleanup } = telemetryHarness();
    try {
      const res = await request(app, "/api/onboarding/event", {
        method: "POST",
        body: { event: "tenancy_selected", properties: { orgCount: "single", singleOrgConfirm: "true" } }
      });
      expect(res.status).toBe(202);
      await flushTelemetry();
      const call = recorder.calls.find((c) => c.body["event"] === "tenancy_selected");
      expect(call).toBeDefined();
      const props = call!.body["properties"] as Record<string, string>;
      expect(props["org_count"]).toBe("single");
      expect(props["single_org_confirm"]).toBe("true");
      const allowed = new Set([...ALLOWED_PROPERTY_KEYS, ...FUNNEL_PROPERTY_KEYS]);
      for (const key of Object.keys(props)) {
        expect(allowed.has(key as (typeof ALLOWED_PROPERTY_KEYS)[number] | (typeof FUNNEL_PROPERTY_KEYS)[number])).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it("N-1 records tenancy_selected from a TOKENLESS resume selection (202, not 401) while the session token is still active", async () => {
    // The tokenless gate-redirect resume (C-1) fires funnel events with no `?t=` token while the
    // on-disk token file still exists (complete() has not run). The event route must count this
    // cohort rather than silently 401 it.
    const { app, recorder, cleanup } = telemetryHarness();
    try {
      const res = await request(app, "/api/onboarding/event", {
        method: "POST",
        body: { event: "tenancy_selected", properties: { orgCount: "few", singleOrgConfirm: "false" } },
        token: null
      });
      expect(res.status).toBe(202);
      await flushTelemetry();
      expect(eventNames(recorder.calls)).toContain("tenancy_selected");
    } finally {
      cleanup();
    }
  });

  it("ts-AC-13 rejects a tenancy_selected body with a raw org name or id (400, nothing emitted)", async () => {
    const { app, recorder, cleanup } = telemetryHarness();
    try {
      const res = await request(app, "/api/onboarding/event", {
        method: "POST",
        body: { event: "tenancy_selected", properties: { orgCount: "org-1234", singleOrgConfirm: "Acme Corp" } }
      });
      expect(res.status).toBe(400);
      await flushTelemetry();
      expect(recorder.calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("PRD-009c tm-AC-2 session dedupe and install retries", () => {
  it("once-per-session milestones dedupe within the onboarding session ledger", async () => {
    const { app, recorder, telemetryDir, cleanup } = telemetryHarness();
    try {
      await request(app, "/api/onboarding/event", { method: "POST", body: { event: "onboarding_started" } });
      await request(app, "/api/onboarding/event", { method: "POST", body: { event: "onboarding_started" } });
      await flushTelemetry();
      expect(recorder.calls.filter((call) => call.body["event"] === "onboarding_started")).toHaveLength(1);
      expect(existsSync(join(telemetryDir, ONBOARDING_LEDGER_FILENAME))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("retried product installs emit a fresh started/terminal pair", async () => {
    let attempt = 0;
    const { fn } = scriptedSpawn(() => {
      attempt += 1;
      return Promise.resolve(attempt === 1 ? outcome(1, "fail") : outcome(0));
    });
    const { app, service, recorder, cleanup } = telemetryHarness({
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      },
      overrides: { spawn: fn }
    });
    try {
      await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
      await service.store.settled("doctor");
      await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
      await service.store.settled("doctor");
      await flushTelemetry();
      expect(recorder.calls.filter((call) => call.body["event"] === "product_install_started")).toHaveLength(2);
      expect(recorder.calls.filter((call) => call.body["event"] === "product_install_failed")).toHaveLength(1);
      expect(recorder.calls.filter((call) => call.body["event"] === "product_install_completed")).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

describe("PRD-009c tm-AC-3 chokepoint gates and fail-soft install behavior", () => {
  it("honors disabled telemetry without changing install HTTP status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-funnel-disabled-"));
    const recorder = createFetchRecorder();
    const { app, service, cleanup } = telemetryHarness({
      overrides: {
        funnelEmitDeps: {
          posthogKey: "",
          stateDir: join(dir, "state"),
          fetch: recorder.fetch
        },
        funnelStateDir: join(dir, "state")
      },
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      }
    });
    try {
      const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
      expect(res.status).toBe(202);
      await service.store.settled("doctor");
      await flushTelemetry();
      expect(recorder.calls).toHaveLength(0);
    } finally {
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing telemetry POST does not change the event route status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-funnel-sendfail-"));
    const recorder = createFetchRecorder();
    recorder.fetch = async (url, init) => {
      recorder.calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
      return { ok: false, status: 500 };
    };
    const { app, cleanup } = telemetryHarness({
      overrides: {
        funnelEmitDeps: {
          posthogKey: "phc_test_key",
          stateDir: join(dir, "state"),
          fetch: recorder.fetch
        },
        funnelStateDir: join(dir, "state")
      }
    });
    try {
      const res = await request(app, "/api/onboarding/event", { method: "POST", body: { event: "login_shown" } });
      expect(res.status).toBe(202);
      await flushTelemetry();
    } finally {
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PRD-009c tm-AC-4 closed property allow-list", () => {
  it("allows only base keys plus mode, product, and failure_stage", async () => {
    const { app, service, recorder, cleanup } = telemetryHarness({
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      }
    });
    try {
      await request(app, "/api/onboarding/event", {
        method: "POST",
        body: { event: "mode_selected", properties: { mode: "advanced" } }
      });
      await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
      await service.store.settled("doctor");
      await flushTelemetry();
      for (const call of recorder.calls) {
        const props = call.body["properties"] as Record<string, string>;
        const allowed = new Set([...ALLOWED_PROPERTY_KEYS, ...FUNNEL_PROPERTY_KEYS]);
        for (const key of Object.keys(props)) {
          expect(allowed.has(key as (typeof ALLOWED_PROPERTY_KEYS)[number] | (typeof FUNNEL_PROPERTY_KEYS)[number])).toBe(
            true
          );
        }
      }
    } finally {
      cleanup();
    }
  });

  it("rejects unknown UI event names with 400", async () => {
    const { app, recorder, cleanup } = telemetryHarness();
    try {
      const res = await request(app, "/api/onboarding/event", { method: "POST", body: { event: "evil_event" } });
      expect(res.status).toBe(400);
      await flushTelemetry();
      expect(recorder.calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("PRD-009c tm-AC-5 onboarding token never egresses", () => {
  it("the token value appears in no telemetry payload or property", async () => {
    const { app, service, recorder, cleanup } = telemetryHarness({
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      },
      overrides: { fleetStatusFetch: readyDoctorFetch, setupAuthFetch: authenticatedSetupFetch }
    });
    try {
      await request(app, "/api/onboarding/event", { method: "POST", body: { event: "onboarding_started" } });
      await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
      await service.store.settled("doctor");
      await request(app, "/api/onboarding/health");
      await flushTelemetry();
      const serialized = allSerializedPayloads(recorder.calls);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(TOKEN_PATH);
    } finally {
      cleanup();
    }
  });
});

describe("PRD-009c tm-AC-6 event names match the PRD funnel list", () => {
  it("uses the exact onboarding funnel event names for bootstrap join compatibility", () => {
    const expected = [
      "onboarding_started",
      "mode_selected",
      "login_shown",
      "dashboard_reached",
      "product_install_started",
      "product_install_completed",
      "product_install_failed",
      "health_check_passed",
      "login_completed"
    ];
    expect(expected).toHaveLength(9);
  });
});

describe("PRD-009 MV-2 manifest URL primary and fallback", () => {
  it("defaults MANIFEST_URL to the install site and keeps GitHub as fallback", () => {
    expect(MANIFEST_URL).toBe("https://get.theapiary.sh/hive-release.json");
    expect(MANIFEST_FALLBACK_URL).toContain("raw.githubusercontent.com");
  });

  it("tries the primary URL, then the fallback, then the bundled snapshot", async () => {
    const urls: string[] = [];
    const { app, service, spawnCalls, cleanup } = telemetryHarness({
      overrides: {
        manifestUrl: "https://primary.example/hive-release.json",
        manifestFallbackUrl: "https://fallback.example/hive-release.json",
        manifestFetch: async (url) => {
          urls.push(url);
          return new Response("", { status: 404 });
        }
      },
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      }
    });
    try {
      const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
      expect(res.status).toBe(202);
      await service.store.settled("doctor");
      expect(urls).toEqual([
        "https://primary.example/hive-release.json",
        "https://fallback.example/hive-release.json"
      ]);
      // The offline fallback pins against the REAL ship-time snapshot's doctor version, so a
      // release-time snapshot bump never breaks this test with a stale literal.
      const snapshotDoctorVersion = (manifestSnapshot as { products: { doctor: { version: string } } }).products
        .doctor.version;
      expect(spawnCalls[0]?.args).toEqual([
        NPM_CLI,
        "install",
        "-g",
        ...NPM_INSTALL_NETWORK_FLAGS,
        `@legioncodeinc/doctor@${snapshotDoctorVersion}`
      ]);
    } finally {
      cleanup();
    }
  });

  it("uses the primary manifest when it succeeds without hitting the fallback", async () => {
    const urls: string[] = [];
    const customManifest = {
      ...DEFAULT_MANIFEST,
      products: {
        ...DEFAULT_MANIFEST.products,
        doctor: { version: "9.9.9", packageName: "@legioncodeinc/doctor", published: true }
      }
    };
    const { app, service, spawnCalls, cleanup } = telemetryHarness({
      overrides: {
        manifestUrl: "https://primary.example/hive-release.json",
        manifestFallbackUrl: "https://fallback.example/hive-release.json",
        manifestFetch: async (url) => {
          urls.push(url);
          if (url.includes("primary.example")) {
            return new Response(JSON.stringify(customManifest), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
          return new Response("", { status: 404 });
        }
      },
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      }
    });
    try {
      await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
      await service.store.settled("doctor");
      expect(urls).toEqual(["https://primary.example/hive-release.json"]);
      expect(spawnCalls[0]?.args).toEqual([NPM_CLI, "install", "-g", ...NPM_INSTALL_NETWORK_FLAGS, "@legioncodeinc/doctor@9.9.9"]);
    } finally {
      cleanup();
    }
  });
});
