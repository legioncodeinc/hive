import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHiveRegistryEntry,
  createNodeRegistryFs,
  registerHiveWithDoctor,
  type RegistryFs
} from "../../src/install/registry.js";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hive-registry-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("hive registry writer", () => {
  it("d-AC-6 appends a hive daemon entry with expected defaults", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "doctor.daemons.json");
      registerHiveWithDoctor({ registryPath });

      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as {
        daemons: Array<Record<string, unknown>>;
      };
      const hive = parsed.daemons.find((entry) => entry["name"] === "hive");
      expect(hive).toEqual(buildHiveRegistryEntry());
    });
  });

  it("d-AC-7 re-run updates hive in place and does not duplicate by name", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "doctor.daemons.json");
      writeFileSync(
        registryPath,
        JSON.stringify(
          {
            daemons: [
              {
                name: "hive",
                healthUrl: "http://127.0.0.1:9999/health",
                pidPath: "~/.honeycomb/old.pid",
                probeIntervalMs: 1,
                startupGraceMs: 2,
                restartGiveUpThreshold: 99,
                restartCooldownMs: 3
              },
              { name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", pidPath: "~/.honeycomb/daemon.pid" }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      registerHiveWithDoctor({ registryPath });
      registerHiveWithDoctor({ registryPath });

      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as {
        daemons: Array<Record<string, unknown>>;
      };
      const matches = parsed.daemons.filter((entry) => entry["name"] === "hive");
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual(buildHiveRegistryEntry());
    });
  });

  it("d-AC-8 writes temp+rename atomically and leaves no partial target write on rename failure", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "doctor.daemons.json");
      const original = JSON.stringify(
        {
          daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", pidPath: "~/.honeycomb/daemon.pid" }]
        },
        null,
        2
      );
      writeFileSync(registryPath, `${original}\n`, "utf8");

      const nodeFs = createNodeRegistryFs();
      const failingFs: RegistryFs = {
        ...nodeFs,
        rename: () => {
          throw new Error("rename failed");
        }
      };

      expect(() => registerHiveWithDoctor({ registryPath, fs: failingFs })).toThrow("rename failed");
      expect(readFileSync(registryPath, "utf8")).toBe(`${original}\n`);
      expect(readdirSync(dir).some((name) => name.includes(".tmp-"))).toBe(false);
    });
  });
});
