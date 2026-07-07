import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { createApiProxy, type ProxyFetch } from "../../src/daemon/proxy.js";
import { createInMemoryProxyCache, type ProxyCache } from "../../src/daemon/proxy-cache.js";

interface RegistryEntry {
  readonly name: string;
  readonly healthUrl: string;
  readonly pidPath: string;
}

async function withRegistry(
  entries: readonly RegistryEntry[],
  run: (registryPath: string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hive-proxy-test-"));
  const registryPath = join(dir, "doctor.daemons.json");
  writeFileSync(registryPath, JSON.stringify({ daemons: entries }), "utf8");
  try {
    await run(registryPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HONEYCOMB: RegistryEntry = { name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health", pidPath: "/tmp/hc.pid" };
const NECTAR: RegistryEntry = { name: "nectar", healthUrl: "http://127.0.0.1:4854/health", pidPath: "/tmp/hn.pid" };

interface AppOptions {
  readonly cache?: ProxyCache;
  readonly now?: () => number;
}

function appWith(registryPath: string, fetchImpl: ProxyFetch, options: AppOptions = {}): Hono {
  const app = new Hono();
  const proxy = createApiProxy({ registryPath, fetchImpl, cache: options.cache, now: options.now });
  app.all("/api/*", proxy);
  app.all("/setup/*", proxy);
  return app;
}

describe("hive server-side API proxy", () => {
  it("forwards a honeycomb-owned request to honeycomb over loopback with method, body, and headers", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchImpl: ProxyFetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      };

      const res = await appWith(registryPath, fetchImpl).request("http://hive.local/api/memories/recall?limit=5", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-honeycomb-session": "dashboard-web",
          authorization: "Bearer token-123"
        },
        body: JSON.stringify({ query: "x" })
      });

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://127.0.0.1:4850/api/memories/recall?limit=5");
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.redirect).toBe("error");

      const forwarded = new Headers(calls[0].init.headers);
      // Pass-through: session + auth headers reach the workload daemon verbatim (hive holds no secret).
      expect(forwarded.get("authorization")).toBe("Bearer token-123");
      expect(forwarded.get("x-honeycomb-session")).toBe("dashboard-web");
      // `host` is stripped so fetch sets it from the target origin.
      expect(forwarded.get("host")).toBeNull();

      const body = calls[0].init.body as ArrayBuffer;
      expect(new TextDecoder().decode(body)).toBe(JSON.stringify({ query: "x" }));
    });
  });

  it("routes /api/hive-graph/* to nectar", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      const seen: string[] = [];
      const fetchImpl: ProxyFetch = async (url) => {
        seen.push(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      };

      await appWith(registryPath, fetchImpl).request("http://hive.local/api/hive-graph/nodes?project=abc");
      expect(seen).toEqual(["http://127.0.0.1:4854/api/hive-graph/nodes?project=abc"]);
    });
  });

  it("streams the upstream status and body back to the caller", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      const fetchImpl: ProxyFetch = async () =>
        new Response(JSON.stringify({ items: [1, 2, 3] }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });

      const res = await appWith(registryPath, fetchImpl).request("http://hive.local/api/memories");
      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toEqual({ items: [1, 2, 3] });
    });
  });

  it("fails soft with a 502 when the upstream daemon is unreachable", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      const fetchImpl: ProxyFetch = async () => {
        throw new Error("ECONNREFUSED");
      };

      const res = await appWith(registryPath, fetchImpl).request("http://hive.local/api/memories");
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toEqual({ error: "unreachable", daemon: "honeycomb" });
    });
  });

  it("never proxies to a non-loopback base from a tampered registry (SSRF guard)", async () => {
    await withRegistry(
      [{ name: "honeycomb", healthUrl: "http://evil.example.com/health", pidPath: "/tmp/hc.pid" }],
      async (registryPath) => {
        const seen: string[] = [];
        const fetchImpl: ProxyFetch = async (url) => {
          seen.push(url);
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        };

        await appWith(registryPath, fetchImpl).request("http://hive.local/api/memories");
        // The tampered non-loopback entry is dropped; resolution falls back to the loopback default,
        // so the proxy targets 127.0.0.1:3850 and never reaches evil.example.com.
        expect(seen).toEqual(["http://127.0.0.1:3850/api/memories"]);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// PRD-012a: server-side BFF proxy read cache.
// ---------------------------------------------------------------------------

describe("PRD-012a: BFF proxy read cache", () => {
  it("cache-hit: a second GET within TTL is served from the cache; fetchImpl called once; bodies identical", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      let calls = 0;
      const fetchImpl: ProxyFetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ count: calls }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      };
      const app = appWith(registryPath, fetchImpl);

      const first = await app.request("http://hive.local/api/diagnostics/kpis");
      const second = await app.request("http://hive.local/api/diagnostics/kpis");

      expect(calls).toBe(1); // only the first crossed loopback
      expect(first.headers.get("x-hive-cache")).toBe("MISS");
      expect(second.headers.get("x-hive-cache")).toBe("HIT");
      // Bodies byte-identical (the cache served the first response, not a refetch).
      await expect(first.json()).resolves.toEqual({ count: 1 });
      await expect(second.json()).resolves.toEqual({ count: 1 });
    });
  });

  it("cache-miss-after-ttl: advancing the injected clock past TTL forces a refetch (MISS)", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      let t = 10_000;
      const now = (): number => t;
      let calls = 0;
      const fetchImpl: ProxyFetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ n: calls }), { status: 200 });
      };
      const app = appWith(registryPath, fetchImpl, { now });

      const first = await app.request("http://hive.local/api/diagnostics/kpis"); // TTL 2000
      expect(first.headers.get("x-hive-cache")).toBe("MISS");

      t += 2_001; // past TTL
      const second = await app.request("http://hive.local/api/diagnostics/kpis");

      expect(calls).toBe(2); // refetched
      expect(second.headers.get("x-hive-cache")).toBe("MISS");
    });
  });

  it("write-invalidates: POST /api/memories busts the memories list + kpis; POST /api/actions/restart does not invalidate", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      let calls = 0;
      const fetchImpl: ProxyFetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ n: calls }), { status: 200 });
      };
      const app = appWith(registryPath, fetchImpl);

      // Warm both the memories list and kpis.
      await app.request("http://hive.local/api/memories?limit=50");
      await app.request("http://hive.local/api/diagnostics/kpis");
      expect(calls).toBe(2);

      // A successful store write invalidates both families.
      const write = await app.request("http://hive.local/api/memories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "new" })
      });
      expect(write.headers.get("x-hive-cache")).toBe("BYPASS");
      expect(write.status).toBe(200);

      // The next reads are MISSes (the write busted them) even though they were just cached.
      const mem = await app.request("http://hive.local/api/memories?limit=50");
      const kpis = await app.request("http://hive.local/api/diagnostics/kpis");
      expect(mem.headers.get("x-hive-cache")).toBe("MISS");
      expect(kpis.headers.get("x-hive-cache")).toBe("MISS");
      expect(calls).toBe(5); // warm(2) + write(1) + refetch(2)

      // Re-warm kpis so we can prove /api/actions/restart does NOT invalidate.
      await app.request("http://hive.local/api/diagnostics/kpis"); // now cached again
      const callsBeforeRestart = calls;

      const restart = await app.request("http://hive.local/api/actions/restart", { method: "POST" });
      expect(restart.headers.get("x-hive-cache")).toBe("BYPASS");

      const after = await app.request("http://hive.local/api/diagnostics/kpis");
      expect(after.headers.get("x-hive-cache")).toBe("HIT"); // restart did not invalidate
      // The restart POST itself fetches upstream (+1), but the kpis read after it is a HIT (no fetch),
      // proving restart did not bust the cache. A restart that invalidated would have made calls +2.
      expect(calls).toBe(callsBeforeRestart + 1);
    });
  });

  it("project-scoping-isolation: two x-honeycomb-project values get distinct cache slots", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      const bodies = { A: JSON.stringify({ project: "A" }), B: JSON.stringify({ project: "B" }) };
      let calls = 0;
      const fetchImpl: ProxyFetch = async (_url, init) => {
        calls += 1;
        const headers = new Headers(init?.headers);
        const project = headers.get("x-honeycomb-project") ?? "A";
        return new Response(bodies[project as "A" | "B"], { status: 200 });
      };
      const app = appWith(registryPath, fetchImpl);

      const a1 = await app.request("http://hive.local/api/diagnostics/kpis", {
        headers: { "x-honeycomb-project": "A" }
      });
      const b1 = await app.request("http://hive.local/api/diagnostics/kpis", {
        headers: { "x-honeycomb-project": "B" }
      });
      expect(calls).toBe(2); // distinct slots → two fetches
      await expect(a1.json()).resolves.toEqual({ project: "A" });
      await expect(b1.json()).resolves.toEqual({ project: "B" });

      // Switch back to A within TTL: HIT, served A's body (no third fetch).
      const a2 = await app.request("http://hive.local/api/diagnostics/kpis", {
        headers: { "x-honeycomb-project": "A" }
      });
      expect(calls).toBe(2);
      expect(a2.headers.get("x-hive-cache")).toBe("HIT");
      await expect(a2.json()).resolves.toEqual({ project: "A" });
    });
  });

  it("coalescing: two concurrent identical GETs in the same tick collapse to one fetch", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      let calls = 0;
      const fetchImpl: ProxyFetch = async () => {
        calls += 1;
        // Yield once so the second request lands while the first is inflight.
        await new Promise<void>((r) => setImmediate(r));
        return new Response(JSON.stringify({ coalesced: true }), { status: 200 });
      };
      const app = appWith(registryPath, fetchImpl);

      const [r1, r2] = await Promise.all([
        app.request("http://hive.local/api/diagnostics/kpis"),
        app.request("http://hive.local/api/diagnostics/kpis")
      ]);

      expect(calls).toBe(1); // single loopback fetch for both
      expect(r1.headers.get("x-hive-cache")).toBe("MISS");
      expect(r2.headers.get("x-hive-cache")).toBe("HIT"); // second awaited the inflight promise
      await expect(r1.json()).resolves.toEqual({ coalesced: true });
      await expect(r2.json()).resolves.toEqual({ coalesced: true });
    });
  });

  it("bypass-non-cacheable: POST /api/memories/recall and GET /setup/state bypass the cache", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      const seen: string[] = [];
      const fetchImpl: ProxyFetch = async (url) => {
        seen.push(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      };
      const app = appWith(registryPath, fetchImpl);

      const recall = await app.request("http://hive.local/api/memories/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: "x" })
      });
      expect(recall.headers.get("x-hive-cache")).toBe("BYPASS");

      const setup = await app.request("http://hive.local/setup/state");
      expect(setup.headers.get("x-hive-cache")).toBe("BYPASS");

      // The bypass paths did not read or populate the cache: a hard-excluded GET like
      // /api/logs/stream is also BYPASS and never cached.
      const stream = await app.request("http://hive.local/api/logs/stream");
      expect(stream.headers.get("x-hive-cache")).toBe("BYPASS");
      expect(seen).toHaveLength(3);
    });
  });

  it("x-hive-cache header on every response: HIT, MISS, and BYPASS", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      const fetchImpl: ProxyFetch = async () => new Response("{}", { status: 200 });
      const app = appWith(registryPath, fetchImpl);

      const miss = await app.request("http://hive.local/api/diagnostics/kpis");
      const hit = await app.request("http://hive.local/api/diagnostics/kpis");
      const bypass = await app.request("http://hive.local/api/memories", { method: "POST", body: "{}" });

      expect(miss.headers.get("x-hive-cache")).toBe("MISS");
      expect(hit.headers.get("x-hive-cache")).toBe("HIT");
      expect(bypass.headers.get("x-hive-cache")).toBe("BYPASS");
    });
  });

  it("loopback-guard-no-cache: the 502 fail-soft path is BYPASS and never populates the cache", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      // A throwing fetchImpl models the unreachable upstream; the cache must never be read or written.
      let calls = 0;
      const fetchImpl: ProxyFetch = async () => {
        calls += 1;
        throw new Error("ECONNREFUSED");
      };
      const app = appWith(registryPath, fetchImpl);

      const res = await app.request("http://hive.local/api/diagnostics/kpis");
      expect(res.status).toBe(502);
      expect(res.headers.get("x-hive-cache")).toBe("MISS"); // failed fetch → MISS, not cached
      expect(calls).toBe(1);

      // A retry still reaches upstream (the failure was not cached) and still fails soft.
      const res2 = await app.request("http://hive.local/api/diagnostics/kpis");
      expect(res2.status).toBe(502);
      expect(res2.headers.get("x-hive-cache")).toBe("MISS");
      expect(calls).toBe(2); // the 502 was not cached → retried
    });
  });

  it("redirect-pin preserved: a 3xx-during-fetch is rejected and never enters the cache", async () => {
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      // fetch with redirect:"error" throws when the upstream returns a 3xx with a Location. We model
      // that by throwing from the fetchImpl (the proxy pins redirect:"error", so any redirect rejects).
      let calls = 0;
      const fetchImpl: ProxyFetch = async (_url, init) => {
        calls += 1;
        // Assert the pin is in place on every proxied fetch.
        expect(init?.redirect).toBe("error");
        throw new Error("redirect rejected");
      };
      const app = appWith(registryPath, fetchImpl);

      const res = await app.request("http://hive.local/api/diagnostics/kpis");
      expect(res.status).toBe(502);
      expect(res.headers.get("x-hive-cache")).toBe("MISS");
      // The rejected fetch never populated the cache: a second call fetches again.
      await app.request("http://hive.local/api/diagnostics/kpis");
      expect(calls).toBe(2);
    });
  });

  it("size-bound-eviction: a cache with capacity 2 evicts the nearest-to-expire entry", async () => {
    // The eviction policy itself is unit-tested in proxy-cache.test.ts; this proves the proxy
    // honors a cache injected with a small capacity without errors.
    await withRegistry([HONEYCOMB, NECTAR], async (registryPath) => {
      let t = 0;
      const cache = createInMemoryProxyCache({ now: () => t, maxEntries: 2 });
      const fetchImpl: ProxyFetch = async () => new Response("{}", { status: 200 });
      const app = appWith(registryPath, fetchImpl, { cache, now: () => t });

      await app.request("http://hive.local/api/diagnostics/kpis"); // expiresAt = 2000
      t = 1_000;
      await app.request("http://hive.local/api/diagnostics/sessions"); // expiresAt = 3000
      t = 2_000;
      // Third distinct cacheable path while at capacity → evicts kpis (nearest expire).
      await app.request("http://hive.local/api/status"); // expiresAt = 4000

      expect(cache.size).toBe(2);
      // kpis was evicted; a read now is a MISS (refetch).
      const kpisAgain = await app.request("http://hive.local/api/diagnostics/kpis");
      expect(kpisAgain.headers.get("x-hive-cache")).toBe("MISS");
    });
  });
});
