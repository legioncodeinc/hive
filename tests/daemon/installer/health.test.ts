/**
 * PRD-009a US-6 health check (is-AC-18): the health endpoint REUSES the existing readiness
 * projection (`fetchFleetStatus` / `isFleetReady`) against doctor's status page rather than
 * re-deriving health. The doctor fetch is mocked so no socket is opened.
 */

import type { HealthResponse } from "../../../src/shared/onboarding-types.js";
import type { FetchImpl as FleetFetchImpl } from "../../../src/daemon/fleet-status.js";
import { makeHarness, request } from "./helpers.js";

const readyDoctorFetch: FleetFetchImpl = async () =>
  new Response(
    JSON.stringify({
      health: "ok",
      asOf: "2026-07-03T12:00:00.000Z",
      daemons: [{ name: "honeycomb", health: "ok", escalation: null }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const unreachableDoctorFetch: FleetFetchImpl = async () => new Response("boom", { status: 502 });

describe("PRD-009a health check", () => {
  it("is-AC-18 reports ready when the reused readiness projection is satisfied", async () => {
    const { app } = makeHarness({ overrides: { fleetStatusFetch: readyDoctorFetch } });
    const res = await request(app, "/api/onboarding/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthResponse;
    expect(body.ready).toBe(true);
    expect(body.status.supervisor).toBe("reachable");
  });

  it("is-AC-18 reports not-ready (never fabricated) when doctor is unreachable", async () => {
    const { app } = makeHarness({ overrides: { fleetStatusFetch: unreachableDoctorFetch } });
    const res = await request(app, "/api/onboarding/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthResponse;
    expect(body.ready).toBe(false);
    expect(body.status.supervisor).toBe("unreachable");
  });

  it("is-AC-9 the health endpoint is token-gated like every state surface", async () => {
    const { app } = makeHarness({ overrides: { fleetStatusFetch: readyDoctorFetch } });
    const res = await request(app, "/api/onboarding/health", { token: null });
    expect(res.status).toBe(401);
  });
});
