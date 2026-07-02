import {
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

// The browser wire is same-origin (hive ADR-0002): every endpoint is fetched from hive's
// own origin, and hive's server-side proxy federates it to the owning daemon. The fail-soft
// posture (a failed/malformed response degrades to the empty state, never a throw) is unchanged.
describe("wire same-origin fetch + fail-soft behavior", () => {
  it("c-AC-1 fetches endpoints from hive's own origin (no client-side daemon base)", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
      const url = requestUrl(input);
      if (url === ENDPOINTS.settings) {
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

    expect(fetchImpl).toHaveBeenCalledWith(ENDPOINTS.settings, expect.any(Object));
  });

  it("c-AC-3 keeps the wire usable after one endpoint fetch fails", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
      const url = requestUrl(input);
      if (url === ENDPOINTS.kpis) throw new Error("kpis down");
      if (url === ENDPOINTS.settings) {
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
      if (url === ENDPOINTS.sessions) return new Response("not-json", { status: 200 });
      return jsonResponse({}, 404);
    }) as unknown as FetchLike;

    const wire = createWireClient({ fetchImpl });

    await expect(wire.sessions()).resolves.toEqual([]);
  });
});
