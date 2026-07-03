/**
 * PRD-009a US-3 origin, host, and token gating (is-AC-7/8/9/10), the three non-negotiable
 * mitigations for a loopback endpoint that shells out to npm.
 */

import { createTokenStore } from "../../../src/daemon/installer/token.js";
import { createInstallerConfig } from "../../../src/daemon/installer/config.js";
import { TOKEN, TOKEN_PATH, makeHarness, request } from "./helpers.js";

describe("PRD-009a installer origin/host/token gating", () => {
  it("is-AC-7 rejects a GET with a foreign Origin (403)", async () => {
    const { app } = makeHarness();
    const res = await request(app, "/api/onboarding/detect", { origin: "http://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("is-AC-7 rejects a state-changing request with a foreign Origin (403), no spawn", async () => {
    const { app, spawnCalls } = makeHarness();
    const res = await request(app, "/api/onboarding/install", {
      method: "POST",
      body: { product: "doctor" },
      origin: "http://evil.example.com"
    });
    expect(res.status).toBe(403);
    expect(spawnCalls).toHaveLength(0);
  });

  it("is-AC-7 rejects a state-changing request with a MISSING Origin (403)", async () => {
    const { app } = makeHarness();
    const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" }, origin: null });
    expect(res.status).toBe(403);
  });

  it("is-AC-7 accepts the portal's own origin (localhost variant included)", async () => {
    const { app } = makeHarness();
    const res = await request(app, "/api/onboarding/detect", { origin: "http://localhost:3853", host: "localhost:3853" });
    expect(res.status).toBe(200);
  });

  it("is-AC-8 rejects a rebound Host header even over loopback (403)", async () => {
    const { app, spawnCalls } = makeHarness();
    const res = await request(app, "/api/onboarding/install", {
      method: "POST",
      body: { product: "doctor" },
      host: "attacker.example.com:3853"
    });
    expect(res.status).toBe(403);
    expect(spawnCalls).toHaveLength(0);
  });

  it("is-AC-9 rejects a request with no token (401)", async () => {
    const { app } = makeHarness();
    const res = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" }, token: null });
    expect(res.status).toBe(401);
  });

  it("is-AC-9 only accepts query-string tokens on the EventSource progress route", async () => {
    const { app, spawnCalls } = makeHarness();

    const detect = await request(app, `/api/onboarding/detect?t=${TOKEN}`, { token: null });
    expect(detect.status).toBe(401);

    const install = await request(app, `/api/onboarding/install?t=${TOKEN}`, {
      method: "POST",
      body: { product: "doctor" },
      token: null
    });
    expect(install.status).toBe(401);
    expect(spawnCalls).toHaveLength(0);

    const events = await request(app, `/api/onboarding/install/doctor/events?t=${TOKEN}`, { token: null });
    expect(events.status).toBe(200);
  });

  it("is-AC-9 rejects a request with a wrong token, both equal-length and different-length (401)", async () => {
    const { app } = makeHarness();
    const sameLength = await request(app, "/api/onboarding/install", {
      method: "POST",
      body: { product: "doctor" },
      token: "x".repeat(TOKEN.length)
    });
    expect(sameLength.status).toBe(401);

    const diffLength = await request(app, "/api/onboarding/install", {
      method: "POST",
      body: { product: "doctor" },
      token: "short"
    });
    expect(diffLength.status).toBe(401);
  });

  it("is-AC-9 the token store compares in constant time and accepts only the exact token", () => {
    const files = new Map<string, string>([[TOKEN_PATH, TOKEN]]);
    const config = createInstallerConfig({
      tokenPath: TOKEN_PATH,
      fileExists: (p) => files.has(p),
      readTextFile: (p) => files.get(p) ?? null,
      deleteFile: (p) => {
        files.delete(p);
      }
    });
    const store = createTokenStore(config);

    expect(store.requireValid(TOKEN)).toBe(true);
    expect(store.requireValid(`${TOKEN}extra`)).toBe(false); // length mismatch branch
    expect(store.requireValid("x".repeat(TOKEN.length))).toBe(false); // equal length, wrong value
    expect(store.requireValid(null)).toBe(false);
  });

  it("is-AC-10 refuses state-changing endpoints after completion, but detect stays token-free", async () => {
    const { app } = makeHarness();

    // While active: detect without a token is refused (a session is in progress).
    const detectActive = await request(app, "/api/onboarding/detect", { token: null });
    expect(detectActive.status).toBe(401);

    // Complete: invalidate the token.
    const complete = await request(app, "/api/onboarding/complete", { method: "POST" });
    expect(complete.status).toBe(204);

    // Post-completion: state-changing endpoints refuse (token invalidated), even with the old token.
    const install = await request(app, "/api/onboarding/install", { method: "POST", body: { product: "doctor" } });
    expect(install.status).toBe(401);

    // Carve-out: detection remains available token-free for the re-entry short-circuit.
    const detectAfter = await request(app, "/api/onboarding/detect", { token: null });
    expect(detectAfter.status).toBe(200);
  });

  it("is-AC-9 no rejection body ever echoes the token", async () => {
    const { app } = makeHarness();
    const res = await request(app, "/api/onboarding/install", {
      method: "POST",
      body: { product: "doctor" },
      token: "wrong-token-value"
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("wrong-token-value");
    expect(text).not.toContain(TOKEN);
  });
});
