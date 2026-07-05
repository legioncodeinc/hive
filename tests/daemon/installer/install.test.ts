/**
 * PRD-009a US-2 allowlisted, manifest-pinned install (is-AC-3/4/5/6), plus US-5 idempotency
 * (is-AC-15 short-circuit, is-AC-16 single-spawn concurrency). Every install target is resolved
 * server-side from the manifest; the request carries only a slug.
 */

import { NPM_INSTALL_NETWORK_FLAGS } from "../../../src/daemon/installer/install-state.js";
// The real ship-time snapshot: the offline-fallback test pins against whatever it carries, so a
// release-time snapshot bump never silently breaks the test with a stale literal.
import manifestSnapshot from "../../../src/daemon/installer/manifest-snapshot.json" with { type: "json" };
import {
  DEFAULT_MANIFEST,
  Deferred,
  FAKE_NODE,
  NPM_CLI,
  binEntryKey,
  makeHarness,
  outcome,
  pkgJsonKey,
  request,
  scriptedSpawn,
  tick
} from "./helpers.js";

function manifestResponse(manifest: unknown): Response {
  return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });
}

/** A harness whose doctor package resolves a registration bin, so a started install runs to completion. */
function harnessWithDoctorBin() {
  return makeHarness({
    files: {
      [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
      [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
    }
  });
}

describe("PRD-009a install allowlist + manifest pinning", () => {
  it("is-AC-3 rejects a non-allowlisted slug with 400 and spawns nothing", async () => {
    const { app, spawnCalls } = makeHarness();
    const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "evil" } });
    expect(res.status).toBe(400);
    expect(spawnCalls).toHaveLength(0);
  });

  it("is-AC-3 rejects `hive` (not installable) with 400 and spawns nothing", async () => {
    const { app, spawnCalls } = makeHarness();
    const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "hive" } });
    expect(res.status).toBe(400);
    expect(spawnCalls).toHaveLength(0);
  });

  it("is-AC-4/6 resolves packageName@version server-side and ignores request-supplied package/version", async () => {
    const { app, service, spawnCalls } = harnessWithDoctorBin();
    const res = await request(app, "/api/onboarding/install", {
      method: "POST",
      body: { product: "doctor", packageName: "@evil/pkg", version: "9.9.9" }
    });
    expect(res.status).toBe(202);
    await service.store.settled("doctor");

    // is-AC-6: an argv array, first element the node binary, never a shell string.
    expect(spawnCalls[0].command).toBe(FAKE_NODE);
    expect(spawnCalls[0].args).toEqual([NPM_CLI, "install", "-g", ...NPM_INSTALL_NETWORK_FLAGS, "@legioncodeinc/doctor@0.2.1"]);
    // is-AC-4: nothing request-supplied reaches the child process.
    const serialized = JSON.stringify(spawnCalls[0]);
    expect(serialized).not.toContain("@evil/pkg");
    expect(serialized).not.toContain("9.9.9");
  });

  it("is-AC-5 refuses an unpublished product with 409 unpublished and never spawns", async () => {
    const manifest = {
      ...DEFAULT_MANIFEST,
      products: { ...DEFAULT_MANIFEST.products, doctor: { ...DEFAULT_MANIFEST.products.doctor, published: false } }
    };
    const { app, spawnCalls } = makeHarness({ overrides: { manifestFetch: async () => manifestResponse(manifest) } });

    const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "unpublished" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("is-AC-5 refuses when the product is missing from the manifest (never falls back to @latest)", async () => {
    const manifest = { manifestVersion: "0.2.1", products: { honeycomb: DEFAULT_MANIFEST.products.honeycomb } };
    const { app, spawnCalls } = makeHarness({ overrides: { manifestFetch: async () => manifestResponse(manifest) } });

    const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "manifest_unresolved" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("is-AC-5 refuses a manifest whose packageName fails the safe-shape check (tampered field)", async () => {
    const manifest = {
      ...DEFAULT_MANIFEST,
      products: { ...DEFAULT_MANIFEST.products, doctor: { version: "0.2.1", packageName: "Evil Name; rm -rf", published: true } }
    };
    const { app, spawnCalls } = makeHarness({ overrides: { manifestFetch: async () => manifestResponse(manifest) } });

    const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "manifest_unresolved" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("falls back to the bundled snapshot when the network manifest fetch fails (still pins, never @latest)", async () => {
    // A throwing manifest fetch: the bundled snapshot still pins doctor to ITS ship-time version.
    const snapshotDoctorVersion = (manifestSnapshot as { products: { doctor: { version: string } } }).products.doctor
      .version;
    const { app, service, spawnCalls } = makeHarness({
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      },
      overrides: {
        manifestFetch: async () => {
          throw new Error("offline");
        }
      }
    });

    const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
    expect(res.status).toBe(202);
    await service.store.settled("doctor");
    expect(spawnCalls[0].args).toEqual([
      NPM_CLI,
      "install",
      "-g",
      ...NPM_INSTALL_NETWORK_FLAGS,
      `@legioncodeinc/doctor@${snapshotDoctorVersion}`
    ]);
  });

  it("is-AC-15 short-circuits to installed (no spawn) when already at the pinned version", async () => {
    const { app, spawnCalls } = makeHarness({
      files: { [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ version: "0.2.1" }) }
    });
    const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ product: "doctor", state: "installed" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("is-AC-16 runs exactly one child process for two concurrent install requests", async () => {
    const npm = new Deferred<ReturnType<typeof outcome>>();
    const { fn, calls } = scriptedSpawn((index) => (index === 0 ? npm.promise : Promise.resolve(outcome(0))));
    const { app } = makeHarness({
      overrides: { spawn: fn },
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ bin: { doctor: "dist/cli.js" } }),
        [binEntryKey("@legioncodeinc/doctor")]: "#!/usr/bin/env node"
      }
    });

    const [first, second] = await Promise.all([
      request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } }),
      request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } })
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await tick();

    // Only the npm install has run; the second request attached to the in-flight state.
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([NPM_CLI, "install", "-g", ...NPM_INSTALL_NETWORK_FLAGS, "@legioncodeinc/doctor@0.2.1"]);

    npm.resolve(outcome(0));
  });
});
