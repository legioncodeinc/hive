import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readRegistryBody,
  resolveRegistryWritePath
} from "../../src/shared/registry-paths.js";
import { resolveFleetRegistryPath } from "../../src/shared/apiary-root.js";
import { resolveLegacyDoctorRegistryPath } from "../../src/shared/legacy-paths.js";

function deps(home: string) {
  return { home, platform: process.platform as NodeJS.Platform, env: {} as NodeJS.ProcessEnv };
}

describe("registry path coordination (rc-AC-3..6)", () => {
  it("rc-AC-3 writes to legacy registry when fleet root directory is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-reg-write-"));
    try {
      expect(resolveRegistryWritePath(deps(home))).toBe(resolveLegacyDoctorRegistryPath(deps(home)));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rc-AC-3 writes to fleet registry when fleet root directory exists", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-reg-write-"));
    try {
      const options = deps(home);
      mkdirSync(join(home, ".apiary"));
      expect(resolveRegistryWritePath(options)).toBe(resolveFleetRegistryPath(options));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rc-AC-4 prefers the new registry path when present", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-reg-read-"));
    try {
      const options = deps(home);
      const newPath = resolveFleetRegistryPath(options);
      mkdirSync(join(home, ".apiary"), { recursive: true });
      writeFileSync(newPath, '{"daemons":[{"name":"hive","healthUrl":"http://127.0.0.1:3853/health","pidPath":"/x"}]}\n', "utf8");
      const legacyPath = resolveLegacyDoctorRegistryPath(options);
      mkdirSync(join(home, ".honeycomb"), { recursive: true });
      writeFileSync(legacyPath, '{"daemons":[]}\n', "utf8");

      const body = readRegistryBody(options);
      expect(body).toContain('"name":"hive"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rc-AC-5 falls back to legacy registry when new path is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-reg-read-"));
    try {
      const options = deps(home);
      const legacyPath = resolveLegacyDoctorRegistryPath(options);
      mkdirSync(join(home, ".honeycomb"), { recursive: true });
      writeFileSync(legacyPath, '{"daemons":[{"name":"nectar","healthUrl":"http://127.0.0.1:3854/health","pidPath":"/y"}]}\n', "utf8");

      const body = readRegistryBody(options);
      expect(body).toContain('"name":"nectar"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rc-AC-6 returns null when neither registry exists", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-reg-read-"));
    try {
      expect(readRegistryBody(deps(home))).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("mg-AC-10 a present-but-unreadable new registry yields null, never stale legacy data", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-reg-read-"));
    try {
      const options = deps(home);
      const legacyReads: string[] = [];
      const readFile = (path: string): string => {
        if (path === resolveLegacyDoctorRegistryPath(options)) {
          legacyReads.push(path);
          return '{"daemons":[{"name":"stale","healthUrl":"http://127.0.0.1:9/health","pidPath":"/stale"}]}';
        }
        // The new file EXISTS but is unreadable (the EACCES class, not absence).
        const eacces: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        eacces.code = "EACCES";
        throw eacces;
      };

      expect(readRegistryBody({ ...options, readFile })).toBeNull();
      expect(legacyReads).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("mg-AC-10 the legacy fallback still fires on ENOENT (absence) of the new path", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-reg-read-"));
    try {
      const options = deps(home);
      const legacyBody = '{"daemons":[]}';
      const readFile = (path: string): string => {
        if (path === resolveLegacyDoctorRegistryPath(options)) return legacyBody;
        const enoent: NodeJS.ErrnoException = new Error("ENOENT: no such file");
        enoent.code = "ENOENT";
        throw enoent;
      };

      expect(readRegistryBody({ ...options, readFile })).toBe(legacyBody);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
