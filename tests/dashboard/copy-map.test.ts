/**
 * PRD-001b b-AC-5 — the copy-map is complete: all 28 honeycomb `web/` files migrated into hive,
 * plus the partial `contracts.ts` and the two shared modules the pages import.
 */

import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const WEB_DIR = join(SRC, "dashboard", "web");

/** Recursively count regular files under a directory. */
function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      total += countFiles(join(dir, entry.name));
    } else if (entry.isFile()) {
      total += 1;
    }
  }
  return total;
}

describe("dashboard copy-map", () => {
  it("b-AC-5 migrated all honeycomb web/ files plus PRD-002b/004/005 readiness+health modules and PRD-003c's boot-route", () => {
    // 36 from the original migration + the PRD-009b `onboarding/` feature-folder files
    // (contracts, the wire client, copy, hooks, the six components, and the resume-selection store)
    // + PRD-012b `use-swr.ts` (client-side stale-while-revalidate hook).
    expect(countFiles(WEB_DIR)).toBe(54);
  });

  it("b-AC-5 includes the shell + infra files (21) and the pages (13)", () => {
    for (const file of [
      "registry.tsx",
      "router.tsx",
      "sidebar.tsx",
      "page-frame.tsx",
      "primitives.tsx",
      "panels.tsx",
      "scope-context.tsx",
      "needs-project.tsx",
      "folder-picker.tsx",
      "harness-strip.tsx",
      "build-graph-button.tsx",
      "graph-layout.ts",
      "wire.ts",
      "hive-graph-projection.ts",
      "app.tsx",
      "main.tsx",
      // PRD-004a: the `/buzzing` screen succeeds PRD-002b's `readiness-splash.tsx` (retired).
      "buzzing-screen.tsx",
      // PRD-004b: the shared bee-state SVG set + state→icon mapping.
      "service-icons.tsx",
      // PRD-004/PRD-005: the one shared SSE-first/REST-fallback telemetry hook.
      "use-fleet-telemetry.ts",
      // PRD-005a: the always-present top health rail.
      "health-rail.tsx",
      "setup-gate.tsx",
      "boot-route.ts",
      "route-daemon-owner.ts",
      // PRD-011b: persistent active-tenancy readout in the shell chrome.
      "active-tenancy-display.tsx"
    ]) {
      expect(existsSync(join(WEB_DIR, file))).toBe(true);
    }
    for (const page of [
      "dashboard.tsx",
      "projects.tsx",
      "harnesses.tsx",
      "memories.tsx",
      "graph.tsx",
      "hive-graph.tsx",
      "sync.tsx",
      "logs.tsx",
      // PRD-005b/PRD-005c: the persistent fleet health page.
      "health.tsx",
      "roi.tsx",
      "roi-chart.tsx",
      "settings.tsx",
      "lifecycle-panel.tsx",
      "coming-soon.tsx"
    ]) {
      expect(existsSync(join(WEB_DIR, "pages", page))).toBe(true);
    }
  });

  it("b-AC-5 brings the partial contracts + the shared modules pages import", () => {
    expect(existsSync(join(SRC, "dashboard", "contracts.ts"))).toBe(true);
    expect(existsSync(join(SRC, "shared", "memory-types.ts"))).toBe(true);
    expect(existsSync(join(SRC, "shared", "lifecycle-flags.ts"))).toBe(true);
    expect(existsSync(join(SRC, "shared", "fleet-readiness.ts"))).toBe(true);
  });
});
