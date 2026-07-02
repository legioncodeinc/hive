import { resolveEndpointOwner } from "../../src/shared/daemon-routing.js";
import { ENDPOINTS } from "../../src/dashboard/web/wire.js";

// Federation is server-side (hive ADR-0002): hive's proxy resolves the owning daemon per
// request via `resolveEndpointOwner`, then fetches it over loopback. These assertions pin the
// endpoint-to-owner routing table the proxy relies on; the browser wire itself is now same-origin.
describe("daemon endpoint ownership routing", () => {
  it("c-AC-1 routes honeycomb dashboard endpoints to honeycomb", () => {
    expect(resolveEndpointOwner(ENDPOINTS.kpis)).toBe("honeycomb");
    expect(resolveEndpointOwner(ENDPOINTS.memories)).toBe("honeycomb");
    expect(resolveEndpointOwner(ENDPOINTS.graph)).toBe("honeycomb");
    expect(resolveEndpointOwner(ENDPOINTS.settings)).toBe("honeycomb");
  });

  it("c-AC-2 routes nectar hive-graph endpoints to nectar", () => {
    expect(resolveEndpointOwner("/api/hive-graph")).toBe("nectar");
    expect(resolveEndpointOwner("/api/hive-graph/nodes")).toBe("nectar");
  });
});
