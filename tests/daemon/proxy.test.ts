import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { createApiProxy, type ProxyFetch } from "../../src/daemon/proxy.js";

interface RegistryEntry {
  readonly name: string;
  readonly healthUrl: string;
  readonly pidPath: string;
}

async function withRegistry(
  entries: readonly RegistryEntry[],
  run: (registryPath: string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thehive-proxy-test-"));
  const registryPath = join(dir, "hivedoctor.daemons.json");
  writeFileSync(registryPath, JSON.stringify({ daemons: entries }), "utf8");
  try {
    await run(registryPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HONEYCOMB: RegistryEntry = { name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health", pidPath: "/tmp/hc.pid" };
const HIVENECTAR: RegistryEntry = { name: "hivenectar", healthUrl: "http://127.0.0.1:4854/health", pidPath: "/tmp/hn.pid" };

function appWith(registryPath: string, fetchImpl: ProxyFetch): Hono {
  const app = new Hono();
  const proxy = createApiProxy({ registryPath, fetchImpl });
  app.all("/api/*", proxy);
  app.all("/setup/*", proxy);
  return app;
}

describe("thehive server-side API proxy", () => {
  it("forwards a honeycomb-owned request to honeycomb over loopback with method, body, and headers", async () => {
    await withRegistry([HONEYCOMB, HIVENECTAR], async (registryPath) => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchImpl: ProxyFetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      };

      const res = await appWith(registryPath, fetchImpl).request("http://thehive.local/api/memories/recall?limit=5", {
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
      // Pass-through: session + auth headers reach the workload daemon verbatim (thehive holds no secret).
      expect(forwarded.get("authorization")).toBe("Bearer token-123");
      expect(forwarded.get("x-honeycomb-session")).toBe("dashboard-web");
      // `host` is stripped so fetch sets it from the target origin.
      expect(forwarded.get("host")).toBeNull();

      const body = calls[0].init.body as ArrayBuffer;
      expect(new TextDecoder().decode(body)).toBe(JSON.stringify({ query: "x" }));
    });
  });

  it("routes /api/source-graph/* to hivenectar", async () => {
    await withRegistry([HONEYCOMB, HIVENECTAR], async (registryPath) => {
      const seen: string[] = [];
      const fetchImpl: ProxyFetch = async (url) => {
        seen.push(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      };

      await appWith(registryPath, fetchImpl).request("http://thehive.local/api/source-graph/nodes?project=abc");
      expect(seen).toEqual(["http://127.0.0.1:4854/api/source-graph/nodes?project=abc"]);
    });
  });

  it("streams the upstream status and body back to the caller", async () => {
    await withRegistry([HONEYCOMB, HIVENECTAR], async (registryPath) => {
      const fetchImpl: ProxyFetch = async () =>
        new Response(JSON.stringify({ items: [1, 2, 3] }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });

      const res = await appWith(registryPath, fetchImpl).request("http://thehive.local/api/memories");
      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toEqual({ items: [1, 2, 3] });
    });
  });

  it("fails soft with a 502 when the upstream daemon is unreachable", async () => {
    await withRegistry([HONEYCOMB, HIVENECTAR], async (registryPath) => {
      const fetchImpl: ProxyFetch = async () => {
        throw new Error("ECONNREFUSED");
      };

      const res = await appWith(registryPath, fetchImpl).request("http://thehive.local/api/memories");
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

        await appWith(registryPath, fetchImpl).request("http://thehive.local/api/memories");
        // The tampered non-loopback entry is dropped; resolution falls back to the loopback default,
        // so the proxy targets 127.0.0.1:3850 and never reaches evil.example.com.
        expect(seen).toEqual(["http://127.0.0.1:3850/api/memories"]);
      }
    );
  });
});
