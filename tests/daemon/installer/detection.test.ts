/**
 * PRD-009a US-1 detection (is-AC-1/2). Detection is derived from LOCAL evidence only (global
 * node_modules + in-memory install state), never from doctor's status page or the request.
 */

import { PRODUCT_SLUGS, type DetectResponse } from "../../../src/shared/onboarding-types.js";
import {
  Deferred,
  makeHarness,
  outcome,
  pkgJsonKey,
  request,
  scriptedSpawn,
  tick
} from "./helpers.js";

async function detect(app: Parameters<typeof request>[0], token?: string | null): Promise<DetectResponse> {
  const res = await request(app, "/api/onboarding/detect", token === undefined ? {} : { token });
  expect(res.status).toBe(200);
  return (await res.json()) as DetectResponse;
}

function expectEnumeratesAllProducts(body: DetectResponse): void {
  expect(Object.keys(body.products).sort()).toEqual([...PRODUCT_SLUGS].sort());
}

describe("PRD-009a detection", () => {
  it("is-AC-1 reports hive installed and the rest not_installed on a fresh machine, without doctor", async () => {
    const { app } = makeHarness();
    const body = await detect(app);

    expectEnumeratesAllProducts(body);
    expect(body.products.hive).toEqual({ state: "installed", version: "0.2.1" });
    expect(body.products.doctor).toEqual({ state: "not_installed" });
    expect(body.products.honeycomb).toEqual({ state: "not_installed" });
    expect(body.products.nectar).toEqual({ state: "not_installed" });
  });

  it("is-AC-2 always enumerates all four products for mixed installed/not_installed states", async () => {
    const { app } = makeHarness({
      files: {
        [pkgJsonKey("@legioncodeinc/doctor")]: JSON.stringify({ version: "0.2.4" }),
        [pkgJsonKey("@legioncodeinc/honeycomb")]: JSON.stringify({ version: "0.2.1" }),
        [pkgJsonKey("@legioncodeinc/nectar")]: JSON.stringify({ version: "0.1.1" })
      }
    });
    const body = await detect(app);

    expectEnumeratesAllProducts(body);
    expect(body.products.hive).toEqual({ state: "installed", version: "0.2.1" });
    expect(body.products.doctor).toEqual({ state: "installed", version: "0.2.4" });
    expect(body.products.honeycomb).toEqual({ state: "installed", version: "0.2.1" });
    expect(body.products.nectar).toEqual({ state: "installed", version: "0.1.1" });
  });

  it("is-AC-2 treats one product read failure as not_installed without dropping siblings", async () => {
    const doctorPkg = pkgJsonKey("@legioncodeinc/doctor");
    const files = new Map<string, string>([
      [pkgJsonKey("@legioncodeinc/honeycomb"), JSON.stringify({ version: "0.2.1" })],
      [pkgJsonKey("@legioncodeinc/nectar"), JSON.stringify({ version: "0.1.1" })]
    ]);
    const { app } = makeHarness({
      overrides: {
        readTextFile: (path) => {
          if (path === doctorPkg) throw new Error("permission denied");
          return files.get(path) ?? null;
        }
      }
    });

    const body = await detect(app);
    expectEnumeratesAllProducts(body);
    expect(body.products.doctor).toEqual({ state: "not_installed" });
    expect(body.products.hive).toEqual({ state: "installed", version: "0.2.1" });
    expect(body.products.honeycomb).toEqual({ state: "installed", version: "0.2.1" });
    expect(body.products.nectar).toEqual({ state: "installed", version: "0.1.1" });
  });

  it("is-AC-2 reports install_in_progress for a product mid-install", async () => {
    const npm = new Deferred<ReturnType<typeof outcome>>();
    const { fn } = scriptedSpawn((index) => (index === 0 ? npm.promise : Promise.resolve(outcome(0))));
    const { app } = makeHarness({ overrides: { spawn: fn } });

    const started = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
    expect(started.status).toBe(202);
    await tick();

    const body = await detect(app);
    expect(body.products.doctor).toEqual({ state: "install_in_progress" });

    npm.resolve(outcome(0));
  });

  it("is-AC-2 reports install_failed with a truthful error after a failed install", async () => {
    const { fn } = scriptedSpawn(() => Promise.resolve(outcome(1, "network error")));
    const { app, service } = makeHarness({ overrides: { spawn: fn } });

    const started = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
    expect(started.status).toBe(202);
    await service.store.settled("doctor");

    const body = await detect(app);
    expect(body.products.doctor.state).toBe("install_failed");
    expect(body.products.doctor.error?.stage).toBe("downloading");
    expect(body.products.doctor.error?.summary).toContain("network error");
  });
});
