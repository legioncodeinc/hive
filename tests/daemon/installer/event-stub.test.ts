/**
 * PRD-009a/009c: `POST /api/onboarding/event` token gate and body validation.
 * Funnel emission coverage lives in `funnel-telemetry.test.ts`.
 */

import { makeHarness, request } from "./helpers.js";

describe("PRD-009 onboarding event route", () => {
  it("rejects an event call with no token (401)", async () => {
    const { app } = makeHarness();
    const res = await request(app, "/api/onboarding/event", {
      method: "POST",
      body: { event: "onboarding_started" },
      token: null
    });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid event body (400)", async () => {
    const { app } = makeHarness();
    const res = await request(app, "/api/onboarding/event", { method: "POST", body: { notEvent: 1 } });
    expect(res.status).toBe(400);
  });

  it("accepts a closed UI event with valid token (202)", async () => {
    const { app } = makeHarness();
    const res = await request(app, "/api/onboarding/event", {
      method: "POST",
      body: { event: "onboarding_started" }
    });
    expect(res.status).toBe(202);
  });
});
