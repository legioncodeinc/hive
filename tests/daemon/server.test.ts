import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThehive,
  startThehive,
  type StartThehiveOptions
} from "../../src/daemon/server.js";
import type { ProxyFetch } from "../../src/daemon/proxy.js";
import type { FetchImpl as FleetFetchImpl } from "../../src/daemon/fleet-status.js";
import type { SetupAuthFetchImpl } from "../../src/daemon/setup-auth.js";
import { THEHIVE_VERSION } from "../../src/shared/constants.js";

/** A fleet-status fetch that always reports honeycomb healthy (PRD-003a's gate then passes health). */
const healthyFleetStatusFetch: FleetFetchImpl = async () =>
  new Response(
    JSON.stringify({
      health: "ok",
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [{ name: "honeycomb", health: "ok", escalation: null }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

/** A `/setup/state` fetch that always reports `authenticated: true` (the gate's auth step then passes). */
const authenticatedSetupAuthFetch: SetupAuthFetchImpl = async () =>
  new Response(JSON.stringify({ authenticated: true }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

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

  it("a-AC-3 serves the dashboard shell immediately when the portal gate passes (healthy + authenticated)", async () => {
    const daemon = createThehive({
      fleetStatusFetch: healthyFleetStatusFetch,
      setupAuthFetch: authenticatedSetupAuthFetch
    });

    const response = await daemon.app.request("http://thehive.local/");
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("id=\"root\"");
    expect(html).toContain("<script type=\"module\" src=\"/app.js\"></script>");
  });

  it("PRD-003a redirects `/` to /buzzing when the fleet is unhealthy (the gate, not the old unconditional shell)", async () => {
    const daemon = createThehive({
      fleetStatusFetch: async () => new Response(JSON.stringify({ supervisor: "unreachable" }), { status: 502 }),
      setupAuthFetch: authenticatedSetupAuthFetch
    });

    const response = await daemon.app.request("http://thehive.local/", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/buzzing");
  });

  it("c-AC-1 proxies /api/* to the owning daemon resolved from the hivedoctor registry", async () => {
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
      const seen: string[] = [];
      const proxyFetch: ProxyFetch = async (url) => {
        seen.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const daemon = createThehive({ registryPath, proxyFetch });

      const honeycombResponse = await daemon.app.request("http://thehive.local/api/memories?limit=10");
      expect(honeycombResponse.status).toBe(200);

      const hivenectarResponse = await daemon.app.request("http://thehive.local/api/source-graph/nodes?project=abc");
      expect(hivenectarResponse.status).toBe(200);

      expect(seen).toEqual([
        "http://127.0.0.1:4850/api/memories?limit=10",
        "http://127.0.0.1:4854/api/source-graph/nodes?project=abc"
      ]);
    });
  });

  it("c-AC-6 serves /api/fleet-status itself rather than proxying it", async () => {
    const proxyFetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as ProxyFetch;
    const daemon = createThehive({
      proxyFetch,
      // A throwing fleet fetch degrades to the fail-soft unreachable body (still HTTP 200) without a socket.
      fleetStatusFetch: async () => {
        throw new Error("no supervisor in test");
      }
    });

    const response = await daemon.app.request("http://thehive.local/api/fleet-status");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ supervisor: "unreachable" });
    expect(proxyFetch).not.toHaveBeenCalled();
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
