import { buildFederatedUrl, resolveEndpointOwner } from "../../src/shared/daemon-routing.js";
import { ENDPOINTS } from "../../src/dashboard/web/wire.js";

describe("federated wire endpoint routing", () => {
  it("c-AC-1 routes copied honeycomb dashboard endpoints to honeycomb", () => {
    expect(resolveEndpointOwner(ENDPOINTS.kpis)).toBe("honeycomb");
    expect(resolveEndpointOwner(ENDPOINTS.memories)).toBe("honeycomb");
    expect(resolveEndpointOwner(ENDPOINTS.graph)).toBe("honeycomb");
    expect(buildFederatedUrl(`${ENDPOINTS.memories}?limit=10`, { honeycomb: "http://honeycomb.local:3850/" })).toBe(
      "http://honeycomb.local:3850/api/memories?limit=10"
    );
  });

  it("c-AC-2 routes hivenectar source-graph endpoints to hivenectar", () => {
    expect(resolveEndpointOwner("/api/source-graph")).toBe("hivenectar");
    expect(resolveEndpointOwner("/api/source-graph/nodes")).toBe("hivenectar");
    expect(buildFederatedUrl("/api/source-graph/nodes?project=abc", { hivenectar: "http://hivenectar.local:3854" })).toBe(
      "http://hivenectar.local:3854/api/source-graph/nodes?project=abc"
    );
  });
});
