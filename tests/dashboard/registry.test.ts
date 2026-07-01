/**
 * PRD-001b b-AC-1 / b-AC-2 — the migrated route registry matches honeycomb's, and every page is
 * a component taking the injected PageProps (hydrates through the shared `wire`, not its own).
 */

import { ROUTES, DEFAULT_ROUTE, matchRoute } from "../../src/dashboard/web/registry.js";
import { createWireClient } from "../../src/dashboard/web/wire.js";

describe("dashboard route registry", () => {
  it("b-AC-1 renders the same ROUTES labels as the honeycomb registry", () => {
    const labels = ROUTES.map((entry) => entry.label);
    expect(labels).toEqual([
      "Dashboard",
      "Projects",
      "Harnesses",
      "Memories",
      "Memory Graph",
      "Sync",
      "Logs",
      "ROI",
      "Settings"
    ]);
  });

  it("b-AC-1 keeps the same hash routes in nav order", () => {
    const routes = ROUTES.map((entry) => entry.route);
    expect(routes).toEqual([
      "/",
      "/projects",
      "/harnesses",
      "/memories",
      "/graph",
      "/sync",
      "/logs",
      "/roi",
      "/settings"
    ]);
  });

  it("b-AC-2 exposes each page as a component that takes PageProps", () => {
    for (const entry of ROUTES) {
      expect(typeof entry.component).toBe("function");
    }
    // The shell injects ONE wire down to every page (pages never build their own); the factory exists.
    expect(typeof createWireClient).toBe("function");
  });

  it("defaults an unknown hash to the Dashboard entry (no blank screen)", () => {
    expect(DEFAULT_ROUTE.route).toBe("/");
    expect(matchRoute("/does-not-exist").route).toBe("/");
    // A deep sub-route resolves to its top-level parent.
    expect(matchRoute("/harnesses/claude-code").route).toBe("/harnesses");
  });
});
