import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHiveRegistryEntry,
  createNodeRegistryFs,
  deleteHiveFromDoctor,
  RegistryDocumentError,
  registerHiveWithDoctor,
  registryContainsHiveEntry,
  resolveRegistryWritePath,
  type RegistryFs
} from "../../src/install/registry.js";
import { resolveFleetRegistryPath, resolveHiveRegistryPidPath } from "../../src/shared/apiary-root.js";
import { resolveLegacyDoctorRegistryPath } from "../../src/shared/legacy-paths.js";

/**
 * A fully in-memory RegistryFs so the default (no registryPath override) candidate
 * fan-out can be exercised hermetically: the resolvers still compute the machine's
 * real candidate paths, but every read/write lands in this map, never on disk.
 */
function createMemoryRegistryFs(seed: Record<string, string>): RegistryFs & { readonly files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    readFile(path: string): string {
      const content = files.get(path);
      if (content === undefined) {
        const error = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
    mkdirp(): void {},
    writeFile(path: string, content: string): void {
      files.set(path, content);
    },
    rename(from: string, to: string): void {
      const content = files.get(from);
      if (content === undefined) throw new Error(`rename source missing: ${from}`);
      files.delete(from);
      files.set(to, content);
    },
    removeFile(path: string): void {
      files.delete(path);
    }
  };
}

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
      expect(hive?.["pidPath"]).toBe(resolveHiveRegistryPidPath());
      if (process.platform !== "win32") expect(statSync(registryPath).mode & 0o777).toBe(0o600);
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

  it("rc-AC-1 preserves other products' entries and unknown root keys byte-for-byte", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "registry.json");
      const honeycombEntry = {
        name: "honeycomb",
        healthUrl: "http://127.0.0.1:3850/health",
        pidPath: "/opt/state/honeycomb.pid",
        probeIntervalMs: 15_000,
        customVendorField: "kept-verbatim"
      };
      const unknownRootValue = { schemaVersion: 3, notes: ["doctor-owned", "hive must not drop this"] };
      writeFileSync(
        registryPath,
        JSON.stringify({ daemons: [honeycombEntry], unknownRootKey: unknownRootValue }, null, 2),
        "utf8"
      );

      registerHiveWithDoctor({ registryPath });

      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as {
        daemons: Array<Record<string, unknown>>;
        unknownRootKey: unknown;
      };
      expect(parsed.daemons.find((entry) => entry["name"] === "honeycomb")).toEqual(honeycombEntry);
      expect(parsed.unknownRootKey).toEqual(unknownRootValue);
      expect(parsed.daemons.find((entry) => entry["name"] === "hive")).toEqual(buildHiveRegistryEntry());
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

  it("fails closed on malformed registry JSON without discarding peer data", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "registry.json");
      const malformed = '{"daemons":[{"name":"honeycomb"}],';
      writeFileSync(registryPath, malformed, "utf8");

      expect(() => registerHiveWithDoctor({ registryPath })).toThrow(RegistryDocumentError);
      expect(() => deleteHiveFromDoctor({ registryPath })).toThrow(RegistryDocumentError);
      expect(readFileSync(registryPath, "utf8")).toBe(malformed);
      expect(readdirSync(dir).some((name) => name.includes(".tmp-") || name.endsWith(".lock"))).toBe(false);
    });
  });

  it("performs the complete read-modify-rename transaction while holding the registry lock", () => {
    const registryPath = "/virtual/registry.json";
    const base = createMemoryRegistryFs({
      [registryPath]: JSON.stringify({ daemons: [{ name: "honeycomb" }] })
    });
    let lockDepth = 0;
    const fs: RegistryFs = {
      ...base,
      readFile(path) {
        expect(lockDepth).toBe(1);
        return base.readFile(path);
      },
      rename(from, to) {
        expect(lockDepth).toBe(1);
        base.rename(from, to);
      },
      withLock(_path, operation) {
        expect(lockDepth).toBe(0);
        lockDepth += 1;
        try { return operation(); } finally { lockDepth -= 1; }
      }
    };

    registerHiveWithDoctor({ registryPath, fs });
    expect(lockDepth).toBe(0);
    expect(JSON.parse(base.files.get(registryPath) ?? "{}").daemons).toEqual([
      { name: "honeycomb" },
      buildHiveRegistryEntry()
    ]);
  });

  it("reclaims an old lock only when its recorded owner is dead", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "registry.json");
      const lockPath = `${registryPath}.lock`;
      writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "dead", createdAt: 0 }));
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);

      expect(registerHiveWithDoctor({ registryPath }).updatedExistingEntry).toBe(false);
      expect(readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(false);
      expect(JSON.parse(readFileSync(registryPath, "utf8")).daemons).toContainEqual(buildHiveRegistryEntry());
    });
  });

  it("does not reclaim an old lock whose recorded owner is still alive", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "registry.json");
      const lockPath = `${registryPath}.lock`;
      const content = JSON.stringify({ pid: process.pid, token: "live", createdAt: 0 });
      writeFileSync(lockPath, content);
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);

      expect(() => registerHiveWithDoctor({ registryPath })).toThrow("Timed out waiting for Doctor registry lock");
      expect(readFileSync(lockPath, "utf8")).toBe(content);
    });
  }, 5_000);

  it("b-AC-3 deleteHiveFromDoctor removes hive and preserves other entries", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "registry.json");
      const honeycombEntry = {
        name: "honeycomb",
        healthUrl: "http://127.0.0.1:3850/health",
        pidPath: "/opt/state/honeycomb.pid"
      };
      registerHiveWithDoctor({ registryPath });
      writeFileSync(
        registryPath,
        JSON.stringify({ daemons: [honeycombEntry, buildHiveRegistryEntry()], schemaVersion: 2 }, null, 2),
        "utf8"
      );

      const result = deleteHiveFromDoctor({ registryPath });
      expect(result.removed).toBe(true);
      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as {
        daemons: Array<Record<string, unknown>>;
        schemaVersion: number;
      };
      expect(parsed.daemons).toEqual([honeycombEntry]);
      expect(parsed.schemaVersion).toBe(2);
      expect(registryContainsHiveEntry({ registryPath })).toBe(false);
    });
  });

  it("b-AC-3 missing registry file or hive entry is a no-op", () => {
    return withTempDir((dir) => {
      const registryPath = join(dir, "missing.json");
      expect(deleteHiveFromDoctor({ registryPath })).toEqual({ removed: false, registryPaths: [] });
    });
  });

  it("b-AC-3 default delete fans out over the write, fleet, and legacy registry paths", () => {
    // No registryPath override: exercises the real candidate chain
    // [resolveRegistryWritePath(), resolveFleetRegistryPath(), resolveLegacyDoctorRegistryPath()]
    // (deduped) with a memory fs, so nothing on the real disk is touched.
    const candidates = [...new Set([resolveRegistryWritePath(), resolveFleetRegistryPath(), resolveLegacyDoctorRegistryPath()])];
    const honeycombEntry = { name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health" };
    const seed: Record<string, string> = {};
    for (const path of candidates) {
      seed[path] = JSON.stringify({ daemons: [honeycombEntry, buildHiveRegistryEntry()] }, null, 2);
    }
    const fs = createMemoryRegistryFs(seed);

    const result = deleteHiveFromDoctor({ fs });

    expect(result.removed).toBe(true);
    expect([...result.registryPaths].sort()).toEqual([...candidates].sort());
    for (const path of candidates) {
      const parsed = JSON.parse(fs.files.get(path) ?? "{}") as { daemons: Array<Record<string, unknown>> };
      expect(parsed.daemons).toEqual([honeycombEntry]);
    }
    expect(registryContainsHiveEntry({ fs })).toBe(false);
  });

  it("b-AC-3 default delete skips absent candidates and removes from the one that has hive", () => {
    const legacyPath = resolveLegacyDoctorRegistryPath();
    const fs = createMemoryRegistryFs({
      [legacyPath]: JSON.stringify({ daemons: [buildHiveRegistryEntry()] }, null, 2)
    });

    const result = deleteHiveFromDoctor({ fs });

    expect(result.removed).toBe(true);
    expect(result.registryPaths).toEqual([legacyPath]);
    const parsed = JSON.parse(fs.files.get(legacyPath) ?? "{}") as { daemons: unknown[] };
    expect(parsed.daemons).toEqual([]);
  });
});
