import { resolveEndpointOwner } from "../../src/shared/daemon-routing.js";
import { ENDPOINTS } from "../../src/dashboard/web/wire.js";

// Federation is server-side (the-hive ADR-0002): thehive's proxy resolves the owning daemon per
// request via `resolveEndpointOwner`, then fetches it over loopback. These assertions pin the
// endpoint-to-owner routing table the proxy relies on; the browser wire itself is now same-origin.
describe("daemon endpoint ownership routing", () => {
  it("c-AC-1 routes honeycomb dashboard endpoints to honeycomb", () => {
    expect(resolveEndpointOwner(ENDPOINTS.kpis)).toBe("honeycomb");
    expect(resolveEndpointOwner(ENDPOINTS.memories)).toBe("honeycomb");
    expect(resolveEndpointOwner(ENDPOINTS.graph)).toBe("honeycomb");
    expect(resolveEndpointOwner(ENDPOINTS.settings)).toBe("honeycomb");
  });

  it("c-AC-2 routes hivenectar source-graph endpoints to hivenectar", () => {
    expect(resolveEndpointOwner("/api/source-graph")).toBe("hivenectar");
    expect(resolveEndpointOwner("/api/source-graph/nodes")).toBe("hivenectar");
  });
});
