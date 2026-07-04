import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHive,
  startHive,
  type StartHiveOptions
} from "../../src/daemon/server.js";
import type { ProxyFetch } from "../../src/daemon/proxy.js";
import type { FetchImpl as FleetFetchImpl } from "../../src/daemon/fleet-status.js";
import type { SetupAuthFetchImpl } from "../../src/daemon/setup-auth.js";
import type { TelemetryFetch } from "../../src/daemon/telemetry-proxy.js";
import { DOCTOR_EVENTS_URL, HIVE_VERSION } from "../../src/shared/constants.js";

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
  const dir = mkdtempSync(join(tmpdir(), "hive-server-test-"));
  const lockPaths = {
    lockFilePath: join(dir, "hive.lock"),
    pidFilePath: join(dir, "hive.pid")
  };
  try {
    await run(lockPaths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("hive daemon server", () => {
  it("a-AC-2 returns a cheap /health body", async () => {
    let now = 1000;
    const daemon = createHive({ now: () => now });

    now = 1750;
    const response = await daemon.app.request("http://hive.local/health");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload).toEqual({
      status: "ok",
      uptimeMs: 750,
      version: HIVE_VERSION
    });
  });

  it("a-AC-3 serves the dashboard shell immediately when the portal gate passes (healthy + authenticated)", async () => {
    const daemon = createHive({
      fleetStatusFetch: healthyFleetStatusFetch,
      setupAuthFetch: authenticatedSetupAuthFetch
    });

    const response = await daemon.app.request("http://hive.local/");
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("id=\"root\"");
    expect(html).toContain("<script type=\"module\" src=\"/app.js\"></script>");
  });

  it("PRD-003a redirects `/` to /buzzing when the fleet is unhealthy (the gate, not the old unconditional shell)", async () => {
    const daemon = createHive({
      fleetStatusFetch: async () => new Response(JSON.stringify({ supervisor: "unreachable" }), { status: 502 }),
      setupAuthFetch: authenticatedSetupAuthFetch
    });

    const response = await daemon.app.request("http://hive.local/", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/buzzing");
  });

  it("c-AC-1 proxies /api/* to the owning daemon resolved from the doctor registry", async () => {
    await withTempLockPaths(async (paths) => {
      const registryPath = join(paths.lockFilePath, "..", "doctor.daemons.json");
      writeFileSync(
        registryPath,
        JSON.stringify({
          daemons: [
            { name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health", pidPath: "/tmp/honeycomb.pid" },
            { name: "nectar", healthUrl: "http://127.0.0.1:4854/health", pidPath: "/tmp/nectar.pid" }
          ]
        }),
        "utf8"
      );
      const seen: string[] = [];
      const proxyFetch: ProxyFetch = async (url) => {
        seen.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const daemon = createHive({ registryPath, proxyFetch });

      const honeycombResponse = await daemon.app.request("http://hive.local/api/memories?limit=10");
      expect(honeycombResponse.status).toBe(200);

      const nectarResponse = await daemon.app.request("http://hive.local/api/hive-graph/nodes?project=abc");
      expect(nectarResponse.status).toBe(200);

      expect(seen).toEqual([
        "http://127.0.0.1:4850/api/memories?limit=10",
        "http://127.0.0.1:4854/api/hive-graph/nodes?project=abc"
      ]);
    });
  });

  it("c-AC-6 serves /api/fleet-status itself rather than proxying it", async () => {
    const proxyFetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as ProxyFetch;
    const daemon = createHive({
      proxyFetch,
      // A throwing fleet fetch degrades to the fail-soft unreachable body (still HTTP 200) without a socket.
      fleetStatusFetch: async () => {
        throw new Error("no supervisor in test");
      }
    });

    const response = await daemon.app.request("http://hive.local/api/fleet-status");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ supervisor: "unreachable" });
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("a-AC-7 keeps construction pure and binds only on startHive", async () => {
    const daemon = createHive();
    expect(daemon.port).toBe(3853);

    const serveFn = vi
      .fn(() => ({
        close(callback?: (error?: Error) => void): void {
          callback?.();
        }
      }))
      .mockName("serveFn") as unknown as StartHiveOptions["serveFn"];

    await withTempLockPaths(async (lockPaths) => {
      let registered = 0;
      const started = startHive({
        serveFn,
        lockPaths,
        migrateState: () => {},
        registerWithDoctor: () => {
          registered += 1;
        }
      });
      expect(serveFn).toHaveBeenCalledTimes(1);
      // rc-AC-2: the registry upsert runs in the same boot, after the lock+pid write.
      expect(registered).toBe(1);
      await started.stop();
    });
  });

  it("rc-AC-2 boot order is migrate, then lock+pid write, then registry upsert, then listen", async () => {
    await withTempLockPaths(async (lockPaths) => {
      const events: string[] = [];
      const serveFn = (() => {
        events.push("serve");
        return {
          close(callback?: (error?: Error) => void): void {
            callback?.();
          }
        };
      }) as unknown as StartHiveOptions["serveFn"];

      const started = startHive({
        serveFn,
        lockPaths,
        migrateState: () => {
          // Migration must run BEFORE the new pid file exists.
          events.push(existsSync(lockPaths.pidFilePath) ? "migrate-after-pid" : "migrate");
        },
        registerWithDoctor: () => {
          // The upsert must observe the pid file already written (no never-existed pidPath window).
          events.push(existsSync(lockPaths.pidFilePath) ? "register-with-pid" : "register-without-pid");
        }
      });

      expect(events).toEqual(["migrate", "register-with-pid", "serve"]);
      await started.stop();
    });
  });

  it("PRD-005b: /health serves the SPA shell for an HTML-accepting request (the operator page), not the liveness JSON", async () => {
    const daemon = createHive({
      fleetStatusFetch: healthyFleetStatusFetch,
      setupAuthFetch: authenticatedSetupAuthFetch
    });
    const response = await daemon.app.request("http://hive.local/health", { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("id=\"root\"");
  });

  it("PRD-005b: /health with an unhealthy fleet still redirects to /buzzing when HTML is requested (a normal gated page)", async () => {
    const daemon = createHive({
      fleetStatusFetch: async () => new Response(JSON.stringify({ supervisor: "unreachable" }), { status: 502 }),
      setupAuthFetch: authenticatedSetupAuthFetch
    });
    const response = await daemon.app.request("http://hive.local/health", { headers: { accept: "text/html" }, redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/buzzing");
  });

  it("a non-HTML /health request (a liveness probe) still gets the cheap JSON body, gate-exempt, even when unhealthy", async () => {
    const daemon = createHive({
      fleetStatusFetch: async () => new Response(JSON.stringify({ supervisor: "unreachable" }), { status: 502 }),
      setupAuthFetch: authenticatedSetupAuthFetch
    });
    const response = await daemon.app.request("http://hive.local/health");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.status).toBe("ok");
  });

  it("PRD-004a/PRD-005a: /api/registered-services returns the full registered-name list from the doctor registry", async () => {
    await withTempLockPaths(async (paths) => {
      const registryPath = join(paths.lockFilePath, "..", "doctor.daemons.json");
      writeFileSync(
        registryPath,
        JSON.stringify({
          daemons: [
            { name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health", pidPath: "/tmp/honeycomb.pid" },
            { name: "nectar", healthUrl: "http://127.0.0.1:4854/health", pidPath: "/tmp/nectar.pid" },
            { name: "hive", healthUrl: "http://127.0.0.1:4853/health", pidPath: "/tmp/hive.pid" }
          ]
        }),
        "utf8"
      );
      const daemon = createHive({ registryPath });
      const response = await daemon.app.request("http://hive.local/api/registered-services");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ names: ["honeycomb", "nectar", "hive"] });
    });
  });

  it("PRD-004/PRD-005: /api/telemetry/stream relays doctor's real SSE URL and never hits the generic daemon proxy", async () => {
    const telemetrySeen: string[] = [];
    const telemetryStreamFetch: TelemetryFetch = async (url) => {
      telemetrySeen.push(url);
      return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
    };
    const proxyFetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as ProxyFetch;

    const daemon = createHive({ telemetryStreamFetch, proxyFetch });
    const response = await daemon.app.request("http://hive.local/api/telemetry/stream");

    expect(response.status).toBe(200);
    expect(telemetrySeen).toEqual([DOCTOR_EVENTS_URL]);
    // The browser's ONLY path is `/api/telemetry/stream`; asserting the generic proxy (which would
    // forward to a workload daemon, not doctor) never sees this request is the same-origin proof.
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("releases lock files if listen fails", () => {
    return withTempLockPaths((lockPaths) => {
      const serveFn = vi
        .fn(() => {
          throw new Error("bind failed");
        })
        .mockName("failingServeFn") as unknown as StartHiveOptions["serveFn"];

      expect(() =>
        startHive({ serveFn, lockPaths, migrateState: () => {}, registerWithDoctor: () => {} })
      ).toThrow("bind failed");
      expect(existsSync(lockPaths.lockFilePath)).toBe(false);
      expect(existsSync(lockPaths.pidFilePath)).toBe(false);
    });
  });
});
