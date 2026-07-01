import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThehive,
  startThehive,
  type StartThehiveOptions
} from "../../src/daemon/server.js";
import { THEHIVE_VERSION } from "../../src/shared/constants.js";

async function withTempLockPaths(run: (paths: { lockFilePath: string; pidFilePath: string }) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thehive-server-test-"));
  const lockPaths = {
    lockFilePath: join(dir, "thehive.lock"),
    pidFilePath: join(dir, "thehive.pid")
  };
  try {
    await run(lockPaths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("thehive daemon server", () => {
  it("a-AC-2 returns a cheap /health body", async () => {
    let now = 1000;
    const daemon = createThehive({ now: () => now });

    now = 1750;
    const response = await daemon.app.request("http://thehive.local/health");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload).toEqual({
      status: "ok",
      uptimeMs: 750,
      version: THEHIVE_VERSION
    });
  });

  it("a-AC-3 serves the dashboard shell immediately", async () => {
    const daemon = createThehive();

    const response = await daemon.app.request("http://thehive.local/");
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("id=\"root\"");
    expect(html).toContain("<script type=\"module\" src=\"/app.js\"></script>");
  });

  it("c-AC-1 exposes daemon bases from the hivedoctor registry", async () => {
    await withTempLockPaths(async (paths) => {
      const registryPath = join(paths.lockFilePath, "..", "hivedoctor.daemons.json");
      writeFileSync(
        registryPath,
        JSON.stringify({
          daemons: [
            { name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health", pidPath: "/tmp/honeycomb.pid" },
            { name: "hivenectar", healthUrl: "http://127.0.0.1:4854/health", pidPath: "/tmp/hivenectar.pid" }
          ]
        }),
        "utf8"
      );
      const daemon = createThehive({ registryPath });

      const response = await daemon.app.request("http://thehive.local/api/daemon-bases");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        honeycomb: "http://127.0.0.1:4850",
        hivenectar: "http://127.0.0.1:4854"
      });
    });
  });

  it("a-AC-7 keeps construction pure and binds only on startThehive", async () => {
    const daemon = createThehive();
    expect(daemon.port).toBe(3853);

    const serveFn = vi
      .fn(() => ({
        close(callback?: (error?: Error) => void): void {
          callback?.();
        }
      }))
      .mockName("serveFn") as unknown as StartThehiveOptions["serveFn"];

    await withTempLockPaths(async (lockPaths) => {
      const started = startThehive({ serveFn, lockPaths });
      expect(serveFn).toHaveBeenCalledTimes(1);
      await started.stop();
    });
  });

  it("releases lock files if listen fails", () => {
    return withTempLockPaths((lockPaths) => {
      const serveFn = vi
        .fn(() => {
          throw new Error("bind failed");
        })
        .mockName("failingServeFn") as unknown as StartThehiveOptions["serveFn"];

      expect(() => startThehive({ serveFn, lockPaths })).toThrow("bind failed");
      expect(existsSync(lockPaths.lockFilePath)).toBe(false);
      expect(existsSync(lockPaths.pidFilePath)).toBe(false);
    });
  });
});
