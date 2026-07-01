import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildThehiveRegistryEntry,
  createNodeRegistryFs,
  registerThehiveWithHivedoctor,
  type RegistryFs
} from "../../src/install/registry.js";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thehive-registry-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("thehive registry writer", () => {
  it("d-AC-6 appends a thehive daemon entry with expected defaults", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "hivedoctor.daemons.json");
      registerThehiveWithHivedoctor({ registryPath });

      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as {
        daemons: Array<Record<string, unknown>>;
      };
      const thehive = parsed.daemons.find((entry) => entry["name"] === "thehive");
      expect(thehive).toEqual(buildThehiveRegistryEntry());
    });
  });

  it("d-AC-7 re-run updates thehive in place and does not duplicate by name", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "hivedoctor.daemons.json");
      writeFileSync(
        registryPath,
        JSON.stringify(
          {
            daemons: [
              {
                name: "thehive",
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

      registerThehiveWithHivedoctor({ registryPath });
      registerThehiveWithHivedoctor({ registryPath });

      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as {
        daemons: Array<Record<string, unknown>>;
      };
      const matches = parsed.daemons.filter((entry) => entry["name"] === "thehive");
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual(buildThehiveRegistryEntry());
    });
  });

  it("d-AC-8 writes temp+rename atomically and leaves no partial target write on rename failure", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "hivedoctor.daemons.json");
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

      expect(() => registerThehiveWithHivedoctor({ registryPath, fs: failingFs })).toThrow("rename failed");
      expect(readFileSync(registryPath, "utf8")).toBe(`${original}\n`);
      expect(readdirSync(dir).some((name) => name.includes(".tmp-"))).toBe(false);
    });
  });
});
