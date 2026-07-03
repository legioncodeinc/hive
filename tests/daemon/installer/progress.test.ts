/**
 * PRD-009a US-4 staged, streamed progress (is-AC-11/12/14) and US-5 failure honesty (is-AC-13/17).
 * Stage ordering, resume-current-stage, disconnect-continues, and truthful registration failures
 * are exercised at the state-store level (deterministic); the SSE endpoint's frame format + the
 * no-percent guarantee are exercised over HTTP.
 */

import type { InstallStage, ProgressEvent } from "../../../src/shared/onboarding-types.js";
import { createInstallStateStore, type InstallTarget } from "../../../src/daemon/installer/install-state.js";
import { createInstallerConfig, type InstallerConfig } from "../../../src/daemon/installer/config.js";
import {
  Deferred,
  FAKE_NODE,
  NPM_CLI,
  NPM_PREFIX,
  binEntryKey,
  makeHarness,
  outcome,
  pkgJsonKey,
  request,
  scriptedSpawn,
  tick
} from "./helpers.js";
import type { SpawnFn, SpawnOutcome } from "../../../src/daemon/installer/spawn.js";

const DOCTOR_TARGET: InstallTarget = {
  packageName: "@legioncodeinc/doctor",
  version: "0.2.1",
  target: "@legioncodeinc/doctor@0.2.1"
};

function storeConfig(spawn: SpawnFn): InstallerConfig {
  const files = new Map<string, string>([
    [pkgJsonKey("@legioncodeinc/doctor"), JSON.stringify({ bin: { doctor: "dist/cli.js" } })],
    [binEntryKey("@legioncodeinc/doctor"), "#!/usr/bin/env node"]
  ]);
  return createInstallerConfig({
    fileExists: (p) => files.has(p),
    readTextFile: (p) => files.get(p) ?? null,
    resolveNpmPrefix: async () => NPM_PREFIX,
    platform: process.platform,
    spawn,
    requireResolve: (s) => (s === "npm/bin/npm-cli.js" ? NPM_CLI : null),
    execPath: FAKE_NODE
  });
}

function collectingSubscriber(): { events: ProgressEvent[]; sub: { send: (e: ProgressEvent) => void; close: () => void } } {
  const events: ProgressEvent[] = [];
  return { events, sub: { send: (e) => events.push(e), close: () => undefined } };
}

describe("PRD-009a install progress state machine", () => {
  it("is-AC-11/12 emits ordered stages from the closed set with no fabricated percentage", async () => {
    const { fn } = scriptedSpawn(() => Promise.resolve(outcome(0)));
    const store = createInstallStateStore(storeConfig(fn));

    store.begin("doctor", DOCTOR_TARGET);
    const { events, sub } = collectingSubscriber();
    store.subscribe("doctor", sub); // synchronous subscribe catches the resolving stage
    await store.settled("doctor");

    const stages = events.map((e) => e.stage);
    expect(stages).toEqual<InstallStage[]>(["resolving", "downloading", "linking", "registering_service", "completed"]);
    // is-AC-12: never a synthesized percent-complete value.
    for (const event of events) {
      expect(Object.keys(event)).not.toContain("percent");
    }
  });

  it("is-AC-14 immediately replays the CURRENT stage to a late subscriber (resume)", async () => {
    const npm = new Deferred<SpawnOutcome>();
    const { fn } = scriptedSpawn((index) => (index === 0 ? npm.promise : Promise.resolve(outcome(0))));
    const store = createInstallStateStore(storeConfig(fn));

    store.begin("doctor", DOCTOR_TARGET);
    await tick(); // advance to the paused `downloading` stage

    const { events, sub } = collectingSubscriber();
    store.subscribe("doctor", sub);
    expect(events[0]?.stage).toBe("downloading");

    npm.resolve(outcome(0));
    await store.settled("doctor");
  });

  it("is-AC-14 the install runs to its terminal state even after every subscriber disconnects", async () => {
    const npm = new Deferred<SpawnOutcome>();
    const { fn } = scriptedSpawn((index) => (index === 0 ? npm.promise : Promise.resolve(outcome(0))));
    const store = createInstallStateStore(storeConfig(fn));

    store.begin("doctor", DOCTOR_TARGET);
    await tick();
    const { sub } = collectingSubscriber();
    const unsubscribe = store.subscribe("doctor", sub);
    unsubscribe(); // the browser tab goes away mid-install

    npm.resolve(outcome(0));
    await store.settled("doctor");

    expect(store.detectState("doctor").status).toBe("installed");
  });

  it("is-AC-13/17 a registration verb failure marks the install failed with a truthful bounded error", async () => {
    const { fn } = scriptedSpawn((index) =>
      index === 0 ? Promise.resolve(outcome(0)) : Promise.resolve(outcome(7, "unit rejected by service manager"))
    );
    const store = createInstallStateStore(storeConfig(fn));

    const { events, sub } = collectingSubscriber();
    store.begin("doctor", DOCTOR_TARGET);
    store.subscribe("doctor", sub);
    await store.settled("doctor");

    const snapshot = store.detectState("doctor");
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error?.stage).toBe("registering_service");
    expect(snapshot.error?.summary).toContain("code 7");
    expect(snapshot.error?.summary).toContain("unit rejected by service manager");
    // The SSE stream carried a terminal `failed` stage, never `completed`.
    expect(events.map((e) => e.stage)).toContain("failed");
    expect(events.map((e) => e.stage)).not.toContain("completed");
  });

  it("is-AC-17 a failed install is retryable", async () => {
    let attempt = 0;
    const fn: SpawnFn = () => {
      attempt += 1;
      // First attempt: npm fails. Later attempts succeed at every step.
      return Promise.resolve(attempt === 1 ? outcome(1, "boom") : outcome(0));
    };
    const store = createInstallStateStore(storeConfig(fn));

    store.begin("doctor", DOCTOR_TARGET);
    await store.settled("doctor");
    expect(store.detectState("doctor").status).toBe("failed");

    // A retry is permitted (not blocked by the prior failure) and can succeed.
    expect(store.begin("doctor", DOCTOR_TARGET)).toBe("started");
    await store.settled("doctor");
    expect(store.detectState("doctor").status).toBe("installed");
  });
});

describe("PRD-009a install progress SSE endpoint", () => {
  it("is-AC-11/12 streams an SSE `data:` frame with a closed-set stage and no percent", async () => {
    const { app, service } = makeHarness({
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      }
    });

    const started = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
    expect(started.status).toBe(202);
    await service.store.settled("doctor");

    const events = await request(app, "/api/onboarding/install/doctor/events");
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toBe("text/event-stream");

    const body = await events.text();
    expect(body).toContain("data: ");
    expect(body).toContain('"stage":"completed"'); // resume replayed the terminal stage
    expect(body).not.toContain("percent");
    expect(body).not.toContain("%");
  });

  it("rejects an SSE subscription for a non-installable product with 400", async () => {
    const { app } = makeHarness();
    const res = await request(app, "/api/onboarding/install/hive/events");
    expect(res.status).toBe(400);
  });
});
