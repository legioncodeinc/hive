/**
 * PRD-011a tenancy wire client: same-origin `/setup/tenancy/*` via hive's BFF proxy (no onboarding
 * token). Mirrors `onboarding-client.ts` fail-soft discipline; lives beside it in the onboarding folder.
 */

import {
	EMPTY_TENANCY_ORGS,
	EMPTY_TENANCY_WORKSPACES,
	SetupTenancySchema,
	TenancyCreateResponseSchema,
	TenancyOrgsSchema,
	TenancySelectResponseSchema,
	TenancyWorkspacesSchema,
	UNSELECTED_SETUP_TENANCY,
	type SetupTenancyWire,
	type TenancyCreateResponseWire,
	type TenancyOrgsWire,
	type TenancySelectResponseWire,
	type TenancyWorkspacesWire,
} from "./tenancy-contracts.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TenancyClientOptions {
	readonly origin?: string;
	readonly fetchImpl?: FetchLike;
}

export interface TenancyClient {
	setupTenancy(): Promise<SetupTenancyWire>;
	listOrgs(): Promise<TenancyOrgsWire>;
	listWorkspaces(orgId: string): Promise<TenancyWorkspacesWire>;
	selectTenancy(orgId: string, workspaceId: string): Promise<TenancySelectResponseWire | null>;
	createWorkspace(org: string, name: string): Promise<TenancyCreateResponseWire | null>;
}

export function createTenancyClient(options: TenancyClientOptions = {}): TenancyClient {
	const origin = options.origin ?? "";
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = (path: string): string => `${origin}${path}`;

	return {
		async setupTenancy(): Promise<SetupTenancyWire> {
			try {
				const res = await fetchImpl(url("/setup/tenancy"), { headers: { accept: "application/json" } });
				if (!res.ok) return UNSELECTED_SETUP_TENANCY;
				const parsed = SetupTenancySchema.safeParse(await res.json());
				return parsed.success ? parsed.data : UNSELECTED_SETUP_TENANCY;
			} catch {
				return UNSELECTED_SETUP_TENANCY;
			}
		},

		async listOrgs(): Promise<TenancyOrgsWire> {
			try {
				const res = await fetchImpl(url("/setup/tenancy/orgs"), { headers: { accept: "application/json" } });
				if (!res.ok) return EMPTY_TENANCY_ORGS;
				const parsed = TenancyOrgsSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : EMPTY_TENANCY_ORGS;
			} catch {
				return EMPTY_TENANCY_ORGS;
			}
		},

		async listWorkspaces(orgId: string): Promise<TenancyWorkspacesWire> {
			try {
				const qs = `?org=${encodeURIComponent(orgId)}`;
				const res = await fetchImpl(url(`/setup/tenancy/workspaces${qs}`), {
					headers: { accept: "application/json" },
				});
				if (!res.ok) return { ...EMPTY_TENANCY_WORKSPACES, org: orgId };
				const parsed = TenancyWorkspacesSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : { ...EMPTY_TENANCY_WORKSPACES, org: orgId };
			} catch {
				return { ...EMPTY_TENANCY_WORKSPACES, org: orgId };
			}
		},

		async selectTenancy(orgId: string, workspaceId: string): Promise<TenancySelectResponseWire | null> {
			try {
				const res = await fetchImpl(url("/setup/tenancy/select"), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ orgId, workspaceId }),
				});
				if (!res.ok) return null;
				const parsed = TenancySelectResponseSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : null;
			} catch {
				return null;
			}
		},

		async createWorkspace(org: string, name: string): Promise<TenancyCreateResponseWire | null> {
			try {
				const res = await fetchImpl(url("/setup/tenancy/workspaces"), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ org, name }),
				});
				if (!res.ok) return null;
				const parsed = TenancyCreateResponseSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : null;
			} catch {
				return null;
			}
		},
	};
}
