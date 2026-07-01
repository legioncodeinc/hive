/**
 * PRD-001b — thehive serves the migrated dashboard SHELL at the root: GET `/` returns a complete
 * HTML page with the `#root` mount point and a `<script>` to the bundled `/app.js`.
 */

import { createThehive } from "../../src/daemon/server.js";
import { mountDashboardHost } from "../../src/daemon/dashboard/host.js";
import { Hono } from "hono";

describe("dashboard host shell", () => {
  it("GET / returns HTML with #root and the app.js script", async () => {
    const daemon = createThehive();

    const response = await daemon.app.request("http://thehive.local/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/html");

    const html = await response.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
  });

  it("serves the shell with an empty asset base (mark served at the root)", async () => {
    const daemon = createThehive();
    const html = await (await daemon.app.request("http://thehive.local/")).text();
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

    const response = await app.request("http://thehive.local/app.js");
    expect(response.status).toBe(404);
  });
});
