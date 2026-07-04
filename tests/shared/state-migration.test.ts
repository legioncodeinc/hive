import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHiveStateDir } from "../../src/shared/apiary-root.js";
import { resolveLegacyHiveStateDir } from "../../src/shared/legacy-paths.js";
import { migrateHiveState } from "../../src/shared/state-migration.js";

async function withTempHome(run: (home: string) => Promise<void> | void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hive-migrate-home-"));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function deps(home: string) {
  return { home, platform: process.platform as NodeJS.Platform, env: {} as NodeJS.ProcessEnv };
}

describe("migrateHiveState (mg-AC-1..4)", () => {
  it("mg-AC-1 copies legacy state dir files byte-identically into the new hive state dir", () => {
    return withTempHome((home) => {
      const legacyRoot = resolveLegacyHiveStateDir(deps(home));
      mkdirSync(legacyRoot, { recursive: true });
      writeFileSync(join(legacyRoot, "install-id"), "legacy-id\n", "utf8");
      writeFileSync(join(legacyRoot, "telemetry.json"), '{"reported":{}}\n', "utf8");

      const result = migrateHiveState(deps(home));
      expect(result.errors).toHaveLength(0);
      expect(result.migratedFiles).toEqual(expect.arrayContaining(["install-id", "telemetry.json"]));

      const newDir = resolveHiveStateDir(deps(home));
      expect(readFileSync(join(newDir, "install-id"), "utf8")).toBe("legacy-id\n");
      expect(readFileSync(join(newDir, "telemetry.json"), "utf8")).toBe('{"reported":{}}\n');
      expect(existsSync(join(legacyRoot, "install-id"))).toBe(false);
    });
  });

  it("mg-AC-2 is idempotent and never overwrites newer new-path files", () => {
    return withTempHome((home) => {
      const options = deps(home);
      const legacyRoot = resolveLegacyHiveStateDir(options);
      mkdirSync(legacyRoot, { recursive: true });
      writeFileSync(join(legacyRoot, "install-id"), "legacy-id\n", "utf8");
      migrateHiveState(options);

      const newDir = resolveHiveStateDir(options);
      writeFileSync(join(newDir, "telemetry.json"), '{"reported":{"x":"1"}}\n', "utf8");
      writeFileSync(join(legacyRoot, "telemetry.json"), '{"reported":{"y":"2"}}\n', "utf8");

      const second = migrateHiveState(options);
      expect(second.migratedFiles).not.toContain("install-id");
      expect(readFileSync(join(newDir, "install-id"), "utf8")).toBe("legacy-id\n");
      expect(readFileSync(join(newDir, "telemetry.json"), "utf8")).toBe('{"reported":{"x":"1"}}\n');
    });
  });

  it("mg-AC-3 leaves legacy files in place when copy fails and still returns errors", () => {
    return withTempHome((home) => {
      const options = deps(home);
      const legacyRoot = resolveLegacyHiveStateDir(options);
      mkdirSync(legacyRoot, { recursive: true });
      writeFileSync(join(legacyRoot, "install-id"), "legacy-id\n", "utf8");

      const newDir = resolveHiveStateDir(options);
      mkdirSync(newDir, { recursive: true });
      mkdirSync(join(newDir, "install-id"), { recursive: true });

      const result = migrateHiveState(options);
      expect(result.errors.length + result.skippedFiles.length).toBeGreaterThan(0);
      expect(existsSync(join(legacyRoot, "install-id"))).toBe(true);
      expect(existsSync(join(newDir, "install-id"))).toBe(true);
    });
  });

  it("mg-AC-4 fresh install creates only the new hive state dir", () => {
    return withTempHome((home) => {
      const options = deps(home);
      migrateHiveState(options);
      const newDir = resolveHiveStateDir(options);
      const legacyRoot = resolveLegacyHiveStateDir(options);
      expect(existsSync(newDir)).toBe(true);
      expect(existsSync(legacyRoot)).toBe(false);
    });
  });
});
