/**
 * PRD-003a — the server-side portal landing gate (g-AC-1 through g-AC-11), plus l-AC-6 (a
 * `/setup/state` fetch failure reads as logged out). Exercises the gate through `createHive`'s
 * full Hono app (`app.request(...)`, no real sockets), matching this repo's existing style
 * (`tests/daemon/server.test.ts`, `tests/daemon/proxy.test.ts`).
 */

import { createHive } from "../../src/daemon/server.js";
import type { FetchImpl as FleetFetchImpl } from "../../src/daemon/fleet-status.js";
import type { SetupAuthFetchImpl } from "../../src/daemon/setup-auth.js";
import type { SetupTenancyFetchImpl } from "../../src/daemon/setup-tenancy.js";

function fleetStatusFetch(health: "ok" | "degraded" | "unreachable"): FleetFetchImpl {
  if (health === "unreachable") {
    return async () => new Response("boom", { status: 502 });
  }
  return async () =>
    new Response(
      JSON.stringify({
        health,
        asOf: "2026-07-01T12:00:00.000Z",
        daemons: [{ name: "honeycomb", health: health === "ok" ? "ok" : "degraded", escalation: null }]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
}

function setupAuthFetch(authenticated: boolean): SetupAuthFetchImpl {
  return async () =>
    new Response(JSON.stringify({ authenticated }), { status: 200, headers: { "content-type": "application/json" } });
}

const throwingSetupAuthFetch: SetupAuthFetchImpl = async () => {
  throw new Error("ECONNREFUSED");
};

function setupTenancyFetch(selected: boolean): SetupTenancyFetchImpl {
  return async () =>
    new Response(JSON.stringify({ selected }), { status: 200, headers: { "content-type": "application/json" } });
}

const throwingSetupTenancyFetch: SetupTenancyFetchImpl = async () => {
  throw new Error("ECONNREFUSED");
};

const HEALTHY = fleetStatusFetch("ok");
const UNHEALTHY = fleetStatusFetch("degraded");
const UNREACHABLE = fleetStatusFetch("unreachable");
const LOGGED_IN = setupAuthFetch(true);
const LOGGED_OUT = setupAuthFetch(false);
const TENANCY_SELECTED = setupTenancyFetch(true);
const TENANCY_UNSELECTED = setupTenancyFetch(false);

function gatedDaemon(options: {
  fleetStatusFetch: FleetFetchImpl;
  setupAuthFetch: SetupAuthFetchImpl;
  setupTenancyFetch?: SetupTenancyFetchImpl;
}) {
  return createHive({
    fleetStatusFetch: options.fleetStatusFetch,
    setupAuthFetch: options.setupAuthFetch,
    setupTenancyFetch: options.setupTenancyFetch ?? TENANCY_SELECTED
  });
}

async function requestPath(
  daemon: ReturnType<typeof createHive>,
  path: string
): Promise<Response> {
  return daemon.app.request(`http://hive.local${path}`, { redirect: "manual" });
}

describe("PRD-003a portal landing gate — precedence", () => {
  it("g-AC-3 redirects a deep link to /buzzing when the fleet is unhealthy, before evaluating auth", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_IN });
    const response = await requestPath(daemon, "/memories");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/buzzing");
  });

  it("g-AC-3 redirects to /buzzing when doctor is unreachable", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: UNREACHABLE, setupAuthFetch: LOGGED_IN });
    const response = await requestPath(daemon, "/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/buzzing");
  });

  it("g-AC-3 redirects to /buzzing FIRST even when also logged out (health wins over auth)", async () => {
    const authCheck: SetupAuthFetchImpl = async () => {
      throw new Error("auth should never be checked when the fleet is unhealthy");
    };
    const daemon = gatedDaemon({ fleetStatusFetch: UNHEALTHY, setupAuthFetch: authCheck });
    const response = await requestPath(daemon, "/settings");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/buzzing");
  });

  it("g-AC-4 redirects to /login when the fleet is healthy but not authenticated", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_OUT });
    const response = await requestPath(daemon, "/projects");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("l-AC-6 treats a /setup/state fetch failure as logged out (redirects to /login, never the dashboard)", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: throwingSetupAuthFetch });
    const response = await requestPath(daemon, "/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("threads the incoming request's abort signal into the /setup/state auth fetch (no pinned upstream request)", async () => {
    let receivedSignal: AbortSignal | undefined;
    const capturingAuthFetch: SetupAuthFetchImpl = async (_input, init) => {
      receivedSignal = init?.signal;
      return new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: capturingAuthFetch });
    await requestPath(daemon, "/");
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("g-AC-5 serves `/` (the dashboard) directly when healthy + authenticated, no redirect", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_IN });
    const response = await requestPath(daemon, "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain('id="root"');
  });

  it("g-AC-6 serves a specific requested route directly when healthy + authenticated (not forced to `/`)", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_IN });
    const response = await requestPath(daemon, "/memories");
    expect(response.status).toBe(200);
    const html = await response.text();
    // The identical shell serves every gated route; the bundled client resolves `/memories` itself.
    expect(html).toContain('id="root"');
  });

  it("g-AC-10 re-runs the identical precedence on every request (refresh-safe, no client-state dependency)", async () => {
    let authenticated = false;
    const flippingAuthFetch: SetupAuthFetchImpl = async () =>
      new Response(JSON.stringify({ authenticated }), { status: 200, headers: { "content-type": "application/json" } });
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: flippingAuthFetch });

    const first = await requestPath(daemon, "/graph");
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/login");

    authenticated = true;
    const second = await requestPath(daemon, "/graph");
    expect(second.status).toBe(200);
  });
});

describe("PRD-003a portal landing gate — exempt screens never redirect", () => {
  const combinations: Array<{ label: string; fleetStatusFetch: FleetFetchImpl; setupAuthFetch: SetupAuthFetchImpl }> = [
    { label: "healthy + logged in", fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_IN },
    { label: "healthy + logged out", fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_OUT },
    { label: "unhealthy + logged in", fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_IN },
    { label: "unhealthy + logged out", fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_OUT },
    { label: "unreachable + logged out", fleetStatusFetch: UNREACHABLE, setupAuthFetch: LOGGED_OUT }
  ];

  for (const { label, fleetStatusFetch: ffs, setupAuthFetch: saf } of combinations) {
    it(`g-AC-7 /buzzing is served directly, never redirected (${label})`, async () => {
      const daemon = gatedDaemon({ fleetStatusFetch: ffs, setupAuthFetch: saf });
      const response = await requestPath(daemon, "/buzzing");
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    });

    it(`g-AC-8 /login is served directly, never redirected (${label})`, async () => {
      const daemon = gatedDaemon({ fleetStatusFetch: ffs, setupAuthFetch: saf });
      const response = await requestPath(daemon, "/login");
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    });
  }

  it("g-AC-9 no sequence of gate evaluations produces a redirect loop between exempt and non-exempt routes", async () => {
    // Walk every reachable state transition an unhealthy, logged-out operator could hit: land on a
    // gated route (redirected to /buzzing), land on /buzzing (served), the fleet recovers but they
    // are still logged out (a gated route now redirects to /login), land on /login (served). At no
    // point does a request to an EXEMPT route itself return a redirect — that is what makes the
    // graph acyclic: /buzzing and /login are terminal nodes, never edges.
    const daemon = gatedDaemon({ fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_OUT });

    const step1 = await requestPath(daemon, "/");
    expect(step1.status).toBe(302);
    expect(step1.headers.get("location")).toBe("/buzzing");

    const step2 = await requestPath(daemon, "/buzzing");
    expect(step2.status).toBe(200);

    const recovered = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_OUT });
    const step3 = await requestPath(recovered, "/");
    expect(step3.status).toBe(302);
    expect(step3.headers.get("location")).toBe("/login");

    const step4 = await requestPath(recovered, "/login");
    expect(step4.status).toBe(200);

    // Sanity: neither exempt route's response ever carries a Location header, in ANY state.
    for (const path of ["/buzzing", "/login"] as const) {
      for (const ffs of [HEALTHY, UNHEALTHY, UNREACHABLE]) {
        for (const saf of [LOGGED_IN, LOGGED_OUT]) {
          const d = gatedDaemon({ fleetStatusFetch: ffs, setupAuthFetch: saf });
          const response = await requestPath(d, path);
          expect(response.status).toBe(200);
          expect(response.headers.get("location")).toBeNull();
        }
      }
    }
  });

  it("g-AC-11 every redirect target is exactly /buzzing, /login, or /onboarding (fixed allowlist)", async () => {
    const unhealthy = await requestPath(gatedDaemon({ fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_OUT }), "/settings");
    expect(unhealthy.headers.get("location")).toBe("/buzzing");

    const loggedOut = await requestPath(gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_OUT }), "/settings");
    expect(loggedOut.headers.get("location")).toBe("/login");

    const tenancyPending = await requestPath(
      gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_IN, setupTenancyFetch: TENANCY_UNSELECTED }),
      "/settings"
    );
    expect(tenancyPending.headers.get("location")).toBe("/onboarding");

    const daemon = gatedDaemon({ fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_OUT });
    const weird = await requestPath(daemon, "/..%2f..%2fevil.example.com");
    expect(weird.headers.get("location")).toBe("/buzzing");
  });
});

describe("PRD-011c portal landing gate - tenancy precedence", () => {
  it("tg-AC-1 redirects to /onboarding when healthy, authenticated, and tenancy unconfirmed", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_IN, setupTenancyFetch: TENANCY_UNSELECTED });
    const response = await requestPath(daemon, "/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/onboarding");
  });

  it("tg-AC-2 skips tenancy check when fleet is unhealthy (redirect /buzzing)", async () => {
    const tenancyCheck: SetupTenancyFetchImpl = async () => {
      throw new Error("tenancy should never run when fleet is unhealthy");
    };
    const daemon = gatedDaemon({ fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_IN, setupTenancyFetch: tenancyCheck });
    const response = await requestPath(daemon, "/memories");
    expect(response.headers.get("location")).toBe("/buzzing");
  });

  it("tg-AC-2 skips tenancy check when unauthenticated (redirect /login)", async () => {
    const tenancyCheck: SetupTenancyFetchImpl = async () => {
      throw new Error("tenancy should never run when logged out");
    };
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_OUT, setupTenancyFetch: tenancyCheck });
    const response = await requestPath(daemon, "/");
    expect(response.headers.get("location")).toBe("/login");
  });

  it("tg-AC-3 serves the dashboard when healthy, authenticated, and tenancy selected", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_IN, setupTenancyFetch: TENANCY_SELECTED });
    const response = await requestPath(daemon, "/");
    expect(response.status).toBe(200);
  });

  it("tg-AC-4 treats a tenancy read failure as unconfirmed (redirect /onboarding)", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_IN, setupTenancyFetch: throwingSetupTenancyFetch });
    const response = await requestPath(daemon, "/graph");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/onboarding");
  });
});

describe("PRD-003c — every pre-migration route is still reachable at its real path", () => {
  it("m-AC-3 serves the identical shell for every route in the registry when healthy + authenticated", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_IN });
    const routes = ["/", "/projects", "/harnesses", "/memories", "/graph", "/sync", "/logs", "/roi", "/settings"];

    const bodies: string[] = [];
    for (const path of routes) {
      const response = await requestPath(daemon, path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('id="root"');
      expect(html).toContain('<script type="module" src="/app.js"></script>');
      bodies.push(html);
    }
    // g-AC-2: the server serves the SAME shell for every path — the bundled client, not the
    // server, resolves the specific screen from `location.pathname` (registry.tsx / router.tsx).
    expect(new Set(bodies).size).toBe(1);
  });
});

describe("PRD-003a portal landing gate — bypasses hive's own infra", () => {
  it("never gates /health, the asset routes, or /api|/setup even when unhealthy + logged out", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_OUT });

    const health = await requestPath(daemon, "/health");
    expect(health.status).toBe(200);

    const fleetStatus = await requestPath(daemon, "/api/fleet-status");
    expect(fleetStatus.status).toBe(200);

    // /setup/* and /api/* proxy to a (here-unregistered) daemon and fail soft with 502 rather than
    // ever being redirected by the gate — the important assertion is "not a 3xx", not the body.
    const setupState = await requestPath(daemon, "/setup/state");
    expect(setupState.status).not.toBe(302);
  });
});

describe("PRD-005b — /health is content-negotiated between the liveness probe and the operator page", () => {
  it("an HTML-accepting request to /health is treated as a normal gated page (redirected when unhealthy)", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_OUT });
    const response = await daemon.app.request("http://hive.local/health", {
      headers: { accept: "text/html" },
      redirect: "manual"
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/buzzing");
  });

  it("a non-HTML request to /health (a liveness probe) is still gate-exempt even when unhealthy + logged out", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: UNHEALTHY, setupAuthFetch: LOGGED_OUT });
    const response = await daemon.app.request("http://hive.local/health", { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("an HTML-accepting request to /health when healthy+authed serves the SPA shell directly (no redirect)", async () => {
    const daemon = gatedDaemon({ fleetStatusFetch: HEALTHY, setupAuthFetch: LOGGED_IN });
    const response = await daemon.app.request("http://hive.local/health", { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="root"');
  });
});
