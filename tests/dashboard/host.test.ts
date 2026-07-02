/**
 * PRD-001b — hive serves the migrated dashboard SHELL: GET a gated path returns a complete
 * HTML page with the `#root` mount point and a `<script>` to the bundled `/app.js`. PRD-003a's
 * portal gate now sits in front of `/`, so these two tests inject a healthy + authenticated fake
 * so the gate passes and the shell round-trip they exercise stays meaningful.
 */

import { createHive } from "../../src/daemon/server.js";
import { mountDashboardHost } from "../../src/daemon/dashboard/host.js";
import type { FetchImpl as FleetFetchImpl } from "../../src/daemon/fleet-status.js";
import type { SetupAuthFetchImpl } from "../../src/daemon/setup-auth.js";
import { Hono } from "hono";

const healthyFleetStatusFetch: FleetFetchImpl = async () =>
  new Response(
    JSON.stringify({
      health: "ok",
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [{ name: "honeycomb", health: "ok", escalation: null }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const authenticatedSetupAuthFetch: SetupAuthFetchImpl = async () =>
  new Response(JSON.stringify({ authenticated: true }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

describe("dashboard host shell", () => {
  it("GET / returns HTML with #root and the app.js script (gate passes: healthy + authenticated)", async () => {
    const daemon = createHive({
      fleetStatusFetch: healthyFleetStatusFetch,
      setupAuthFetch: authenticatedSetupAuthFetch
    });

    const response = await daemon.app.request("http://hive.local/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/html");

    const html = await response.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
  });

  it("serves the shell with an empty asset base (mark served at the root)", async () => {
    const daemon = createHive({
      fleetStatusFetch: healthyFleetStatusFetch,
      setupAuthFetch: authenticatedSetupAuthFetch
    });
    const html = await (await daemon.app.request("http://hive.local/")).text();
    expect(html).toContain('data-asset-base=""');
    expect(html).toContain('href="/honeycomb-memory-cluster.svg"');
  });

  it("404s the app bundle route when no bundle is available (fail-soft, no 500)", async () => {
    const app = new Hono();
    // Inject an asset reader with no bundle so the route resolves to a 404, never a throw/500.
    mountDashboardHost(app, {
      assets: {
        css: () => null,
        logo: () => null,
        appJs: () => null,
        font: () => null
      }
    });

    const response = await app.request("http://hive.local/app.js");
    expect(response.status).toBe(404);
  });
});
