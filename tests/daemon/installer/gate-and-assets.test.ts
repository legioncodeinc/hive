/**
 * PRD-009a wiring: `/onboarding` is gate-exempt (reachable pre-health / pre-auth), the installer
 * API is served by hive itself (not the BFF proxy), the brand SVGs are served under `/assets/brand/`,
 * and the `/setup/*` login surface stays reachable during onboarding (is-AC-19).
 */

import { createHive } from "../../../src/daemon/server.js";
import type { FetchImpl as FleetFetchImpl } from "../../../src/daemon/fleet-status.js";
import type { SetupAuthFetchImpl } from "../../../src/daemon/setup-auth.js";

const unhealthyFleet: FleetFetchImpl = async () => new Response("boom", { status: 502 });
const loggedOut: SetupAuthFetchImpl = async () =>
  new Response(JSON.stringify({ authenticated: false }), { status: 200, headers: { "content-type": "application/json" } });

function onboardingDaemon() {
  return createHive({
    fleetStatusFetch: unhealthyFleet,
    setupAuthFetch: loggedOut,
    installer: {
      // Keep detection from resolving a real npm prefix (no child process in the test).
      resolveNpmPrefix: async () => null,
      // Hermetic token state: the default path is the REAL ~/.honeycomb/hive/onboarding-token,
      // which exists on a machine mid-onboarding and would flip detect into 401-without-token.
      tokenPath: "/nonexistent/hive-test/onboarding-token"
    }
  });
}

describe("PRD-009a onboarding route + asset wiring", () => {
  it("serves /onboarding directly (gate-exempt) even when unhealthy and logged out", async () => {
    const daemon = onboardingDaemon();
    const res = await daemon.app.request("http://127.0.0.1:3853/onboarding", { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain('id="root"');
  });

  it("serves the installer API itself (not via the BFF proxy) and the gate never redirects it", async () => {
    const daemon = onboardingDaemon();
    const res = await daemon.app.request("http://127.0.0.1:3853/api/onboarding/detect", {
      headers: { host: "127.0.0.1:3853", origin: "http://127.0.0.1:3853" },
      redirect: "manual"
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: Record<string, { state: string }> };
    expect(body.products.hive.state).toBe("installed");
  });

  it("serves a brand mark under /assets/brand/*.svg", async () => {
    const daemon = onboardingDaemon();
    const res = await daemon.app.request("http://127.0.0.1:3853/assets/brand/doctor-mark.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    const body = await res.text();
    expect(body).toContain("<svg");
  });

  it("serves the copied doctor and nectar marks (the ones the onboarding cards need)", async () => {
    const daemon = onboardingDaemon();
    for (const name of ["doctor-mark.svg", "nectar-mark.svg", "hive-mark.svg"]) {
      const res = await daemon.app.request(`http://127.0.0.1:3853/assets/brand/${name}`);
      expect(res.status).toBe(200);
    }
  });

  it("rejects a non-svg or traversal-shaped brand asset name with 404", async () => {
    const daemon = onboardingDaemon();
    const notSvg = await daemon.app.request("http://127.0.0.1:3853/assets/brand/secrets.txt");
    expect(notSvg.status).toBe(404);
    const missing = await daemon.app.request("http://127.0.0.1:3853/assets/brand/nope.svg");
    expect(missing.status).toBe(404);
  });

  it("is-AC-19 the /setup/* login surface stays reachable during onboarding (gate never redirects it)", async () => {
    const daemon = onboardingDaemon();
    const state = await daemon.app.request("http://127.0.0.1:3853/setup/state", { redirect: "manual" });
    expect(state.status).not.toBe(302);
    const login = await daemon.app.request("http://127.0.0.1:3853/setup/login", { method: "POST", redirect: "manual" });
    expect(login.status).not.toBe(302);
  });
});
