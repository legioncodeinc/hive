/**
 * PRD-001b b-AC-5 — the copy-map is complete: all 28 honeycomb `web/` files migrated into thehive,
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
  it("b-AC-5 migrated all 28 honeycomb web/ files", () => {
    expect(countFiles(WEB_DIR)).toBe(28);
  });

  it("b-AC-5 includes the shell + infra files (12) and the pages (12)", () => {
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
      "app.tsx",
      "main.tsx",
      "setup-gate.tsx"
    ]) {
      expect(existsSync(join(WEB_DIR, file))).toBe(true);
    }
    for (const page of [
      "dashboard.tsx",
      "projects.tsx",
      "harnesses.tsx",
      "memories.tsx",
      "graph.tsx",
      "sync.tsx",
      "logs.tsx",
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
  });
});
