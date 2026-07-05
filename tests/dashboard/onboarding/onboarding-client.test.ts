/**
 * PRD-009b detect-client hardening: normalize detect payloads to the full four-product fleet map.
 */

import { createOnboardingClient, ONBOARDING_TOKEN_HEADER } from "../../../src/dashboard/web/onboarding/onboarding-client.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("createOnboardingClient.detect", () => {
	it("normalizes a partial detect payload so all four products are always present", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				products: {
					hive: { state: "installed", version: "0.2.1" },
					honeycomb: { state: "installed", version: "0.2.2" },
				},
			}),
		);
		const client = createOnboardingClient("fleet-token", { fetchImpl });

		const result = await client.detect();

		expect(fetchImpl).toHaveBeenCalledWith("/api/onboarding/detect", expect.objectContaining({
			headers: expect.objectContaining({
				accept: "application/json",
				[ONBOARDING_TOKEN_HEADER]: "fleet-token",
			}),
		}));
		expect(result.products.hive).toEqual({ state: "installed", version: "0.2.1" });
		expect(result.products.honeycomb).toEqual({ state: "installed", version: "0.2.2" });
		expect(result.products.doctor).toEqual({ state: "not_installed" });
		expect(result.products.nectar).toEqual({ state: "not_installed" });
	});

	it("fails soft to a full not_installed map when detect payload is malformed", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ nope: true }));
		const client = createOnboardingClient("fleet-token", { fetchImpl });

		const result = await client.detect();

		expect(result.products.hive).toEqual({ state: "not_installed" });
		expect(result.products.doctor).toEqual({ state: "not_installed" });
		expect(result.products.honeycomb).toEqual({ state: "not_installed" });
		expect(result.products.nectar).toEqual({ state: "not_installed" });
	});
});
