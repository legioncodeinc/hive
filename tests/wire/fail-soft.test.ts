import {
  DAEMON_BASES_ENDPOINT,
  EMPTY_KPIS,
  ENDPOINTS,
  createWireClient,
  type FetchLike
} from "../../src/dashboard/web/wire.js";

function requestUrl(input: Parameters<FetchLike>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("federated wire fail-soft behavior", () => {
  it("c-AC-1 loads daemon bases once and fetches honeycomb-owned endpoints from honeycomb", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
      const url = requestUrl(input);
      if (url === DAEMON_BASES_ENDPOINT) {
        return jsonResponse({ honeycomb: "http://127.0.0.1:4850", hivenectar: "http://127.0.0.1:4854" });
      }
      if (url === "http://127.0.0.1:4850/api/diagnostics/settings") {
        return jsonResponse({ orgId: "org", orgName: "Org", workspace: "workspace", settings: { mode: "ok" } });
      }
      return jsonResponse({}, 404);
    }) as unknown as FetchLike;

    const wire = createWireClient({ fetchImpl });
    await expect(wire.settings()).resolves.toEqual({
      orgId: "org",
      orgName: "Org",
      workspace: "workspace",
      settings: { mode: "ok" }
    });

    expect(fetchImpl).toHaveBeenCalledWith(DAEMON_BASES_ENDPOINT, { headers: { accept: "application/json" } });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4850/api/diagnostics/settings", expect.any(Object));
  });

  it("c-AC-3 keeps the wire usable after one endpoint fetch fails", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
      const url = requestUrl(input);
      if (url === DAEMON_BASES_ENDPOINT) {
        return jsonResponse({ honeycomb: "http://127.0.0.1:4850", hivenectar: "http://127.0.0.1:4854" });
      }
      if (url === "http://127.0.0.1:4850/api/diagnostics/kpis") throw new Error("honeycomb kpis down");
      if (url === "http://127.0.0.1:4850/api/diagnostics/settings") {
        return jsonResponse({ orgId: "org", orgName: "Org", workspace: "workspace", settings: {} });
      }
      return jsonResponse({}, 404);
    }) as unknown as FetchLike;

    const wire = createWireClient({ fetchImpl });

    await expect(wire.kpis()).resolves.toEqual(EMPTY_KPIS);
    await expect(wire.settings()).resolves.toMatchObject({ orgId: "org", workspace: "workspace" });
  });

  it("c-AC-4 degrades malformed JSON through existing safe empty states", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
      const url = requestUrl(input);
      if (url === DAEMON_BASES_ENDPOINT) return jsonResponse({ honeycomb: "http://127.0.0.1:4850" });
      if (url === `http://127.0.0.1:4850${ENDPOINTS.sessions}`) return new Response("not-json", { status: 200 });
      return jsonResponse({}, 404);
    }) as unknown as FetchLike;

    const wire = createWireClient({ fetchImpl });

    await expect(wire.sessions()).resolves.toEqual([]);
  });
});
