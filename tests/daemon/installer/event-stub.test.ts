/**
 * PRD-009a/009c: `POST /api/onboarding/event` token gate and body validation.
 * Funnel emission coverage lives in `funnel-telemetry.test.ts`.
 *
 * PRD-011 N-1: the route's token mode is `optional`, not `always`. The tokenless gate-redirect
 * resume path (C-1) carries no `?t=` token by design, so tokenless events are ACCEPTED (or the
 * resume cohort is silently undercounted); a token that IS presented must still be valid.
 */

import { makeHarness, request } from "./helpers.js";

describe("PRD-009 onboarding event route", () => {
	it("N-1 accepts a tokenless event call (202, the gate-redirect resume cohort)", async () => {
		const { app } = makeHarness();
		const res = await request(app, "/api/onboarding/event", {
			method: "POST",
			body: { event: "onboarding_started" },
			token: null
		});
		expect(res.status).toBe(202);
	});

	it("N-1 still rejects a PRESENTED-but-wrong token (401, token-bearing behavior intact)", async () => {
		const { app } = makeHarness();
		const res = await request(app, "/api/onboarding/event", {
			method: "POST",
			body: { event: "onboarding_started" },
			token: "wrong-token-value"
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
