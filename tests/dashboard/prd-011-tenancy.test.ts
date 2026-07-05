/**
 * PRD-011: tenancy contracts, display helpers, and onboarding wire client (AC-named).
 */

import { describe, expect, it, vi } from "vitest";

import { deriveActiveTenancyLabel, formatActiveTenancyLabel, formatNectarPanelTenancy } from "../../src/dashboard/web/active-tenancy-display.js";
import {
	SetupTenancySchema,
	TenancyOrgsSchema,
	TenancySelectResponseSchema,
	TenancyWorkspacesSchema,
} from "../../src/dashboard/web/onboarding/tenancy-contracts.js";
import { createTenancyClient } from "../../src/dashboard/web/onboarding/tenancy-client.js";
import type { SetupTenancyResultWire } from "../../src/dashboard/web/wire.js";

function selectedTenancy(): SetupTenancyResultWire {
	return {
		pending: false,
		selected: true,
		authenticated: true,
		org: { id: "org-a", name: "Org A" },
		workspace: { id: "ws-1", name: "Workspace One" },
		unreachable: false,
	};
}

describe("PRD-011b active tenancy display", () => {
	it("tv-AC-1 shows org and workspace names when selected", () => {
		const label = deriveActiveTenancyLabel(selectedTenancy());
		expect(formatActiveTenancyLabel(label)).toBe("Org A · Workspace One");
	});

	it("tv-AC-2 shows tenancy unavailable when the read is unreachable", () => {
		const label = deriveActiveTenancyLabel({ ...selectedTenancy(), unreachable: true });
		expect(formatActiveTenancyLabel(label)).toBe("tenancy unavailable");
	});

	it("tv-AC-3 distinguishes not linked from tenancy not selected", () => {
		expect(formatActiveTenancyLabel(deriveActiveTenancyLabel({ ...selectedTenancy(), authenticated: false, selected: false, unreachable: false }))).toBe(
			"not linked",
		);
		expect(formatActiveTenancyLabel(deriveActiveTenancyLabel({ ...selectedTenancy(), authenticated: true, selected: false, unreachable: false }))).toBe(
			"tenancy not selected",
		);
	});

	it("tv-AC-8 prefers nectar body tenancy fields when present", () => {
		const line = formatNectarPanelTenancy({ org: "Nectar Org", workspace: "Nectar WS" }, deriveActiveTenancyLabel(selectedTenancy()));
		expect(line).toBe("Nectar Org · Nectar WS");
	});

	it("tv-AC-8 falls back to fleet credential tenancy when body fields are absent", () => {
		const line = formatNectarPanelTenancy(undefined, deriveActiveTenancyLabel(selectedTenancy()));
		expect(line).toBe("Org A · Workspace One (fleet credential)");
	});

	it("hints a grandfathered confirmation in the label (honeycomb confirmedBy)", () => {
		const label = deriveActiveTenancyLabel({ ...selectedTenancy(), confirmedBy: "grandfathered" });
		expect(formatActiveTenancyLabel(label)).toBe("Org A · Workspace One (grandfathered)");
		const explicit = deriveActiveTenancyLabel({ ...selectedTenancy(), confirmedBy: "selection" });
		expect(formatActiveTenancyLabel(explicit)).toBe("Org A · Workspace One");
	});
});

describe("PRD-011a tenancy contracts (ts-AC-11)", () => {
	it("ts-AC-11 degrades malformed GET /setup/tenancy bodies safely", () => {
		const parsed = SetupTenancySchema.parse({ selected: "nope" });
		expect(parsed.selected).toBe(false);
		expect(parsed.pending).toBe(true);
	});

	it("ts-AC-11 org and workspace list schemas default empty arrays", () => {
		expect(TenancyOrgsSchema.parse({}).orgs).toEqual([]);
		expect(TenancyWorkspacesSchema.parse({}).workspaces).toEqual([]);
		expect(TenancyWorkspacesSchema.parse({}).canCreate).toBe(false);
	});

	it("ts-AC-11 models confirmedBy (reconciled honeycomb field) and degrades a malformed value to absent", () => {
		const grandfathered = SetupTenancySchema.parse({ selected: true, authenticated: true, confirmedBy: "grandfathered" });
		expect(grandfathered.confirmedBy).toBe("grandfathered");
		const explicit = SetupTenancySchema.parse({ selected: true, authenticated: true, confirmedBy: "selection" });
		expect(explicit.confirmedBy).toBe("selection");
		const absent = SetupTenancySchema.parse({ selected: true, authenticated: true });
		expect(absent.confirmedBy).toBeUndefined();
		// Fail-soft: a bogus value degrades to absent rather than failing the whole tenancy read.
		const bogus = SetupTenancySchema.parse({ selected: true, authenticated: true, confirmedBy: "bogus" });
		expect(bogus.confirmedBy).toBeUndefined();
		expect(bogus.selected).toBe(true);
	});

	it("ts-AC-8 accepts canonical select ack shapes", () => {
		const ok = TenancySelectResponseSchema.parse({
			selected: true,
			org: { id: "o", name: "O" },
			workspace: { id: "w", name: "W" },
			reminted: true,
		});
		expect(ok.selected).toBe(true);
		const err = TenancySelectResponseSchema.parse({ selected: false, error: "denied" });
		expect(err.selected).toBe(false);
	});
});

describe("PRD-011a tenancy client", () => {
	it("ts-AC-2 short-circuits when setupTenancy reports selected: true", async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const path = String(input);
			if (path.endsWith("/setup/tenancy")) {
				return new Response(JSON.stringify({ selected: true, pending: false, authenticated: true, org: null, workspace: null }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`unexpected ${path}`);
		});
		const client = createTenancyClient({ fetchImpl });
		const status = await client.setupTenancy();
		expect(status.selected).toBe(true);
	});

	it("ts-AC-6 omits create when canCreate is false", async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const path = String(input);
			if (path.includes("/setup/tenancy/workspaces?")) {
				return new Response(JSON.stringify({ org: "o1", workspaces: [{ id: "w1", name: "W1" }], canCreate: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});
		const client = createTenancyClient({ fetchImpl });
		const ws = await client.listWorkspaces("o1");
		expect(ws.canCreate).toBe(false);
		expect(ws.workspaces).toHaveLength(1);
	});

	it("ts-AC-12 sends NO onboarding token (and no auth header of any kind) on any tenancy call", async () => {
		const seenHeaders: Array<Record<string, string>> = [];
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			seenHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) });
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		});
		const client = createTenancyClient({ fetchImpl });

		await client.setupTenancy();
		await client.listOrgs();
		await client.listWorkspaces("o1");
		await client.selectTenancy("o1", "w1");
		await client.createWorkspace("o1", "New WS");

		expect(seenHeaders).toHaveLength(5);
		for (const headers of seenHeaders) {
			const keys = Object.keys(headers).map((k) => k.toLowerCase());
			expect(keys).not.toContain("x-onboarding-token");
			expect(keys).not.toContain("authorization");
			expect(keys.every((k) => k === "accept" || k === "content-type")).toBe(true);
		}
	});

	it("ts-AC-8 posts { orgId, workspaceId } to /setup/tenancy/select", async () => {
		let body = "";
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			if (path.endsWith("/setup/tenancy/select") && init?.method === "POST") {
				body = String(init.body);
				return new Response(
					JSON.stringify({ selected: true, org: { id: "o1", name: "O" }, workspace: { id: "w1", name: "W" }, reminted: false }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("{}", { status: 404 });
		});
		const client = createTenancyClient({ fetchImpl });
		const ack = await client.selectTenancy("o1", "w1");
		expect(JSON.parse(body)).toEqual({ orgId: "o1", workspaceId: "w1" });
		expect(ack?.selected).toBe(true);
	});
});
