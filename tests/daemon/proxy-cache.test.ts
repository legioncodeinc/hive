import { describe, it, expect } from "vitest";

import {
  CACHEABLE_PATHS,
  computeCacheKey,
  createInMemoryProxyCache,
  defaultInvalidatePrefix,
  isHardExcluded,
  resolveWriteInvalidations
} from "../../src/daemon/proxy-cache.js";
import type { DaemonName } from "../../src/shared/daemon-routing.js";

function res(body = "hello"): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

describe("createInMemoryProxyCache — TTL expiry", () => {
  it("returns a fresh entry within TTL and undefined once the clock passes expiresAt", () => {
    let t = 1_000;
    const cache = createInMemoryProxyCache({ now: () => t });

    cache.set("GET:honeycomb:/api/diagnostics/kpis::", res(), 2_000);
    expect(cache.get("GET:honeycomb:/api/diagnostics/kpis::")?.kind).toBe("fresh");

    t += 1_999; // still inside the 2000ms window
    expect(cache.get("GET:honeycomb:/api/diagnostics/kpis::")?.kind).toBe("fresh");

    t += 2; // now past expiresAt
    expect(cache.get("GET:honeycomb:/api/diagnostics/kpis::")).toBeUndefined();
  });
});

describe("createInMemoryProxyCache — inflight coalescing", () => {
  it("stores an inflight promise and returns it from get", async () => {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((r) => {
      resolve = r;
    });
    const cache = createInMemoryProxyCache();
    cache.setInflight("GET:honeycomb:/api/memories?limit=50::", promise);

    const entry = cache.get("GET:honeycomb:/api/memories?limit=50::");
    expect(entry?.kind).toBe("inflight");

    resolve(res("filled"));
    const awaited = await (entry as { promise: Promise<Response> }).promise;
    expect(await awaited.text()).toBe("filled");
  });
});

describe("createInMemoryProxyCache — deleteByPrefix", () => {
  it("removes only the owner+prefix entries, leaving unrelated keys intact", () => {
    // key = `${method}:${owner}:${pathname}:${search}:${projectHeader}`
    const cache = createInMemoryProxyCache();
    const memListKey = "GET:honeycomb:/api/memories?limit=50:";
    const memIdKey = "GET:honeycomb:/api/memories/abc?limit=50:";
    const kpisKey = "GET:honeycomb:/api/diagnostics/kpis::A";
    const nectarProjKey = "GET:nectar:/api/hive-graph/projection::";

    cache.set(memListKey, res(), 2_000);
    cache.set(memIdKey, res(), 2_000);
    cache.set(kpisKey, res(), 2_000);
    cache.set(nectarProjKey, res(), 5_000);

    // honeycomb:/api/memories hits both memListKey and memIdKey, NOT kpisKey or nectarProjKey.
    cache.deleteByPrefix("honeycomb", "/api/memories");

    expect(cache.get(memListKey)).toBeUndefined();
    expect(cache.get(memIdKey)).toBeUndefined();
    expect(cache.get(kpisKey)?.kind).toBe("fresh");
    expect(cache.get(nectarProjKey)?.kind).toBe("fresh");
  });

  it("a prefix of '' invalidates every entry for that owner (org-switch ALL case)", () => {
    const cache = createInMemoryProxyCache();
    const h1 = "GET:honeycomb:/api/memories::";
    const h2 = "GET:honeycomb:/api/diagnostics/kpis::";
    const n1 = "GET:nectar:/api/hive-graph/status::";
    cache.set(h1, res(), 2_000);
    cache.set(h2, res(), 2_000);
    cache.set(n1, res(), 2_000);

    cache.deleteByPrefix("honeycomb", "");
    expect(cache.get(h1)).toBeUndefined();
    expect(cache.get(h2)).toBeUndefined();
    expect(cache.get(n1)?.kind).toBe("fresh"); // nectar untouched
  });
});

describe("createInMemoryProxyCache — clear", () => {
  it("wipes every entry", () => {
    const cache = createInMemoryProxyCache();
    cache.set("GET:honeycomb:/api/status::", res(), 2_000);
    cache.set("GET:honeycomb:/api/logs::", res(), 2_000);
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("GET:honeycomb:/api/status::")).toBeUndefined();
  });
});

describe("createInMemoryProxyCache — eviction", () => {
  it("evicts the nearest-to-expire fresh entry when the cap is reached", () => {
    let t = 0;
    const cache = createInMemoryProxyCache({ now: () => t, maxEntries: 2 });

    cache.set("GET:honeycomb:/api/memories::", res("a"), 2_000); // expiresAt = 2000
    cache.set("GET:honeycomb:/api/diagnostics/kpis::", res("b"), 5_000); // expiresAt = 5000
    expect(cache.size).toBe(2);

    // Third distinct insert while at capacity: the nearest-to-expire (2000) must be evicted.
    cache.set("GET:honeycomb:/api/status::", res("c"), 30_000); // expiresAt = 30000

    expect(cache.size).toBe(2);
    expect(cache.get("GET:honeycomb:/api/memories::")).toBeUndefined(); // evicted (earliest expiry)
    expect(cache.get("GET:honeycomb:/api/diagnostics/kpis::")?.kind).toBe("fresh");
    expect(cache.get("GET:honeycomb:/api/status::")?.kind).toBe("fresh");
  });
});

describe("CACHEABLE_PATHS — exact-match lookup", () => {
  it("returns the TTL for cacheable paths", () => {
    expect(CACHEABLE_PATHS.get("/api/diagnostics/kpis")).toBe(2_000);
    expect(CACHEABLE_PATHS.get("/api/logs")).toBe(2_000);
    expect(CACHEABLE_PATHS.get("/api/memories")).toBe(2_000);
    expect(CACHEABLE_PATHS.get("/api/diagnostics/memory-graph")).toBe(5_000);
    expect(CACHEABLE_PATHS.get("/api/settings")).toBe(30_000);
  });

  it("returns undefined for non-cacheable / near-miss paths (exact match, not prefix)", () => {
    expect(CACHEABLE_PATHS.get("/api/logs/stream")).toBeUndefined();
    expect(CACHEABLE_PATHS.get("/api/logs/history")).toBeUndefined();
    expect(CACHEABLE_PATHS.get("/api/memories/abc-123")).toBeUndefined();
    expect(CACHEABLE_PATHS.get("/api/memories/recall")).toBeUndefined();
    expect(CACHEABLE_PATHS.get("/api/diagnostics/kpis/extra")).toBeUndefined();
    expect(CACHEABLE_PATHS.get("/setup/state")).toBeUndefined();
  });
});

describe("isHardExcluded", () => {
  it("excludes POST /api/memories/recall, the SSE tails, setup, onboarding, and /api/memories/:id GET", () => {
    expect(isHardExcluded("POST", "/api/memories/recall")).toBe(true);
    expect(isHardExcluded("GET", "/setup/state")).toBe(true);
    expect(isHardExcluded("GET", "/setup")).toBe(true);
    expect(isHardExcluded("GET", "/api/logs/stream")).toBe(true);
    expect(isHardExcluded("GET", "/api/logs/history")).toBe(true);
    expect(isHardExcluded("GET", "/api/telemetry/stream")).toBe(true);
    expect(isHardExcluded("GET", "/api/onboarding/state")).toBe(true);
    expect(isHardExcluded("GET", "/api/onboarding")).toBe(true);
    expect(isHardExcluded("GET", "/api/memories/abc-123")).toBe(true);
  });

  it("does NOT exclude cacheable reads or ordinary writes", () => {
    expect(isHardExcluded("GET", "/api/diagnostics/kpis")).toBe(false);
    expect(isHardExcluded("GET", "/api/memories")).toBe(false);
    expect(isHardExcluded("GET", "/api/logs")).toBe(false);
    expect(isHardExcluded("POST", "/api/memories")).toBe(false);
    expect(isHardExcluded("POST", "/api/diagnostics/compact")).toBe(false);
  });
});

describe("computeCacheKey", () => {
  it("encodes method:owner:pathname:search:projectHeader verbatim", () => {
    expect(computeCacheKey("GET", "honeycomb", "/api/diagnostics/kpis", "?foo=bar", "proj-a")).toBe(
      "GET:honeycomb:/api/diagnostics/kpis:?foo=bar:proj-a"
    );
    // No search, no project header → empty segments.
    expect(computeCacheKey("GET", "honeycomb", "/api/diagnostics/kpis", "", "")).toBe(
      "GET:honeycomb:/api/diagnostics/kpis::"
    );
    // nectar is its own partition.
    expect(computeCacheKey("GET", "nectar", "/api/hive-graph/status", "", "")).toBe(
      "GET:nectar:/api/hive-graph/status::"
    );
  });
});

describe("resolveWriteInvalidations", () => {
  const honeycomb: DaemonName = "honeycomb";
  const nectar: DaemonName = "nectar";

  it("matches the POST /api/memories rule and busts memories + kpis", () => {
    const targets = resolveWriteInvalidations("POST", honeycomb, "/api/memories");
    expect(targets).toEqual([
      { owner: "honeycomb", prefix: "/api/memories" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" }
    ]);
  });

  it("matches the /:id/modify and /:id/forget rules", () => {
    expect(resolveWriteInvalidations("POST", honeycomb, "/api/memories/abc/modify")).toEqual([
      { owner: "honeycomb", prefix: "/api/memories" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" }
    ]);
    expect(resolveWriteInvalidations("POST", honeycomb, "/api/memories/abc/forget")).toEqual([
      { owner: "honeycomb", prefix: "/api/memories" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" }
    ]);
  });

  it("matches the diagnostics sync/* family", () => {
    for (const action of ["promote", "pull", "demote", "enable", "disable"]) {
      expect(resolveWriteInvalidations("POST", honeycomb, `/api/diagnostics/sync/${action}`)).toEqual([
        { owner: "honeycomb", prefix: "/api/diagnostics/skills" },
        { owner: "honeycomb", prefix: "/api/diagnostics/assets" },
        { owner: "honeycomb", prefix: "/api/diagnostics/kpis" }
      ]);
    }
  });

  it("POST /api/actions/restart invalidates nothing", () => {
    expect(resolveWriteInvalidations("POST", honeycomb, "/api/actions/restart")).toEqual([]);
  });

  it("POST /api/diagnostics/scope/org-switch invalidates ALL honeycomb entries", () => {
    expect(resolveWriteInvalidations("POST", honeycomb, "/api/diagnostics/scope/org-switch")).toEqual([
      { owner: "honeycomb", prefix: "" }
    ]);
  });

  it("nectar writes target nectar prefixes", () => {
    expect(resolveWriteInvalidations("POST", nectar, "/api/hive-graph/build")).toEqual([
      { owner: "nectar", prefix: "/api/hive-graph/status" },
      { owner: "nectar", prefix: "/api/hive-graph/projection" }
    ]);
  });

  it("falls back to the conservative same-owner broad-prefix default for unmatched writes", () => {
    // A POST to a path not in the explicit table → /{seg1}/{seg2} on the same owner.
    expect(resolveWriteInvalidations("POST", honeycomb, "/api/something/new")).toEqual([
      { owner: "honeycomb", prefix: defaultInvalidatePrefix("/api/something/new") }
    ]);
    expect(defaultInvalidatePrefix("/api/something/new")).toBe("/api/something");
  });

  it("GET methods never trigger write invalidations through the default (they hit the fallback but are gated by the proxy)", () => {
    // resolveWriteInvalidations is method-agnostic about the default; the proxy only calls it for non-GET.
    expect(resolveWriteInvalidations("PUT", honeycomb, "/api/widgets/123")).toEqual([
      { owner: "honeycomb", prefix: "/api/widgets" }
    ]);
  });
});
