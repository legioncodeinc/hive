/**
 * PRD-011c gate tenancy input: fail-closed read of honeycomb `GET /setup/tenancy` `selected` bit.
 * Mirrors `setup-auth.ts` construction exactly (tg-AC-5).
 */

import { z } from "zod";

import { isLoopbackBaseUrl } from "../shared/daemon-routing.js";
import { resolveDaemonBases } from "./registry.js";

const SetupTenancySelectedSchema = z.object({
	selected: z.boolean().catch(false),
});

export type SetupTenancyFetchInit = {
	readonly redirect?: "error" | "follow" | "manual";
	readonly signal?: AbortSignal;
};
export type SetupTenancyFetchImpl = (input: string, init?: SetupTenancyFetchInit) => Promise<Response>;

export interface FetchTenancySelectedOptions {
	readonly registryPath?: string;
	readonly signal?: AbortSignal;
}

/**
 * Resolve whether tenancy is confirmed for the gate's third precedence step (tg-AC-1..4).
 * Returns `false` on ANY failure so a transient fault lands on `/onboarding`, never the dashboard.
 */
export async function fetchTenancySelected(
	fetchImpl: SetupTenancyFetchImpl = fetch,
	options: FetchTenancySelectedOptions = {},
): Promise<boolean> {
	const base = resolveDaemonBases({ registryPath: options.registryPath }).honeycomb;
	if (!isLoopbackBaseUrl(base)) return false;

	try {
		const response = await fetchImpl(`${base}/setup/tenancy`, { redirect: "error", signal: options.signal });
		if (!response.ok) return false;

		let parsedJson: unknown;
		try {
			parsedJson = await response.json();
		} catch {
			return false;
		}

		const parsed = SetupTenancySelectedSchema.safeParse(parsedJson);
		return parsed.success ? parsed.data.selected : false;
	} catch {
		return false;
	}
}
