import { createHive } from "../../src/daemon/server.js";
import {
  fetchFleetStatus,
  isFleetReady,
  type FleetStatusResponse
} from "../../src/daemon/fleet-status.js";
import { DOCTOR_STATUS_URL } from "../../src/shared/constants.js";

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 502);
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body
  })) as unknown as typeof fetch;
}

function mockFailingFetch(error: Error): typeof fetch {
  return vi.fn(async () => {
    throw error;
  }) as unknown as typeof fetch;
}

describe("fetchFleetStatus", () => {
  it("fs-AC-3 returns fail-soft unreachable when doctor fetch throws", async () => {
    const result = await fetchFleetStatus(mockFailingFetch(new Error("connection refused")));
    expect(result).toEqual({ supervisor: "unreachable", daemons: [] });
  });

  it("fs-AC-3 returns fail-soft unreachable when doctor responds non-200", async () => {
    const result = await fetchFleetStatus(mockFetch(null, { ok: false, status: 503 }));
    expect(result).toEqual({ supervisor: "unreachable", daemons: [] });
  });

  it("fs-AC-4 returns fail-soft unreachable on malformed JSON body", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      }
    })) as unknown as typeof fetch;

    const result = await fetchFleetStatus(fetchImpl);
    expect(result).toEqual({ supervisor: "unreachable", daemons: [] });
  });

  it("fs-AC-4 returns fail-soft unreachable when JSON fails zod validation", async () => {
    const result = await fetchFleetStatus(mockFetch({ health: "ok" }));
    expect(result).toEqual({ supervisor: "unreachable", daemons: [] });
  });

  it("fs-AC-5 passes through well-formed status with daemons array", async () => {
    const upstream = {
      health: "ok",
      escalation: null,
      suggestedCommands: ["doctor status"],
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [
        { name: "honeycomb", health: "ok", escalation: null },
        { name: "nectar", health: "degraded", escalation: { reason: "stale" } }
      ]
    };

    const result = await fetchFleetStatus(mockFetch(upstream));
    expect(result).toEqual({
      supervisor: "reachable",
      health: "ok",
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [
        { name: "honeycomb", health: "ok", escalation: null },
        { name: "nectar", health: "degraded", escalation: { reason: "stale" } },
        { name: "doctor", kind: "supervisor", health: "ok", escalation: null }
      ]
    });
  });

  it("fs-AC-5 defaults daemons to empty when absent (older doctor)", async () => {
    const upstream = {
      health: "ok",
      escalation: null,
      suggestedCommands: ["doctor status"],
      asOf: "2026-07-01T12:00:00.000Z"
    };

    const result = await fetchFleetStatus(mockFetch(upstream));
    expect(result).toEqual({
      supervisor: "reachable",
      health: "ok",
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [{ name: "doctor", kind: "supervisor", health: "ok", escalation: null }]
    });
  });

  it("surfaces doctor from upstream as supervisor without duplicating rows", async () => {
    const upstream = {
      health: "degraded",
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [
        { name: "doctor", health: "degraded", escalation: null },
        { name: "honeycomb", health: "ok", escalation: null }
      ]
    };

    const result = await fetchFleetStatus(mockFetch(upstream));
    expect(result).toEqual({
      supervisor: "reachable",
      health: "degraded",
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [
        { name: "doctor", kind: "supervisor", health: "degraded", escalation: null },
        { name: "honeycomb", health: "ok", escalation: null }
      ]
    });
  });

  it("fs-AC-9 rejects non-loopback URL without fetching", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ health: "ok", asOf: "2026-07-01T12:00:00.000Z" })
    })) as unknown as typeof fetch;

    const result = await fetchFleetStatus(fetchImpl, "http://evil.example/status.json");
    expect(result).toEqual({ supervisor: "unreachable", daemons: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fs-AC-2 uses hard-pinned loopback constant by default", () => {
    expect(DOCTOR_STATUS_URL).toBe("http://127.0.0.1:3852/status.json");
  });

  it("fs-AC-9 pins redirect mode so a loopback 3xx cannot follow off loopback", async () => {
    const fetchImpl = mockFetch({ health: "ok", asOf: "2026-07-01T12:00:00.000Z" });
    await fetchFleetStatus(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(DOCTOR_STATUS_URL, { redirect: "error" });
  });

  it("fs-AC-9 fail-softs when the fetch rejects on a redirect", async () => {
    const result = await fetchFleetStatus(mockFailingFetch(new TypeError("unexpected redirect")));
    expect(result).toEqual({ supervisor: "unreachable", daemons: [] });
  });
});

describe("isFleetReady", () => {
  const readyPayload: FleetStatusResponse = {
    supervisor: "reachable",
    health: "ok",
    asOf: "2026-07-01T12:00:00.000Z",
    daemons: [{ name: "honeycomb", health: "ok", escalation: null }]
  };

  it("fs-AC-6 returns true when supervisor reachable, aggregate ok, and honeycomb ok", () => {
    expect(isFleetReady(readyPayload)).toBe(true);
  });

  it("fs-AC-7 returns true when aggregate health is degraded (an answering daemon is UP; honeycomb/nectar boot degraded until a workspace is bound)", () => {
    expect(
      isFleetReady({
        ...readyPayload,
        health: "degraded"
      })
    ).toBe(true);
  });

  it("fs-AC-7 returns false when aggregate health is unreachable", () => {
    expect(
      isFleetReady({
        ...readyPayload,
        health: "unreachable"
      })
    ).toBe(false);
  });

  it("fs-AC-7 returns false when aggregate health is unknown", () => {
    expect(
      isFleetReady({
        ...readyPayload,
        health: "unknown"
      })
    ).toBe(false);
  });

  it("fs-AC-8 returns false when honeycomb is missing from daemons", () => {
    expect(
      isFleetReady({
        supervisor: "reachable",
        health: "ok",
        asOf: "2026-07-01T12:00:00.000Z",
        daemons: [{ name: "nectar", health: "ok", escalation: null }]
      })
    ).toBe(false);
  });

  it("fs-AC-8 returns false when daemons array is empty", () => {
    expect(
      isFleetReady({
        supervisor: "reachable",
        health: "ok",
        asOf: "2026-07-01T12:00:00.000Z",
        daemons: []
      })
    ).toBe(false);
  });

  it("fs-AC-6 returns false when supervisor is unreachable", () => {
    expect(isFleetReady({ supervisor: "unreachable", daemons: [] })).toBe(false);
  });
});

describe("GET /api/fleet-status route", () => {
  it("fs-AC-1 proxies doctor status through hive server", async () => {
    const fleetStatusFetch = mockFetch({
      health: "ok",
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [{ name: "honeycomb", health: "ok", escalation: null }]
    });

    const daemon = createHive({
      fleetStatusFetch,
      doctorStatusUrl: DOCTOR_STATUS_URL
    });

    const response = await daemon.app.request("http://hive.local/api/fleet-status");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      supervisor: "reachable",
      health: "ok",
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [
        { name: "honeycomb", health: "ok", escalation: null },
        { name: "doctor", kind: "supervisor", health: "ok", escalation: null }
      ]
    });
    expect(fleetStatusFetch).toHaveBeenCalledWith(DOCTOR_STATUS_URL, { redirect: "error" });
  });

  it("fs-AC-3 route returns 200 with fail-soft body when upstream is down", async () => {
    const daemon = createHive({
      fleetStatusFetch: mockFailingFetch(new Error("ECONNREFUSED"))
    });

    const response = await daemon.app.request("http://hive.local/api/fleet-status");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      supervisor: "unreachable",
      daemons: []
    });
  });

  it("fs-AC-10 response body contains only normalized fields", async () => {
    const fleetStatusFetch = mockFetch({
      health: "ok",
      asOf: "2026-07-01T12:00:00.000Z",
      daemons: [{ name: "honeycomb", health: "ok", escalation: null }]
    });

    const daemon = createHive({ fleetStatusFetch });
    const response = await daemon.app.request("http://hive.local/api/fleet-status");
    const payload = await response.json();

    expect(Object.keys(payload).sort()).toEqual(["asOf", "daemons", "health", "supervisor"]);
    expect(payload).not.toHaveProperty("suggestedCommands");
    expect(payload).not.toHaveProperty("escalation");
    expect(JSON.stringify(payload)).not.toContain("3852");
  });
});
