// @vitest-environment jsdom
/**
 * hive scope-context: the "reverts to OSPRY" display-desync fix (org/workspace switcher
 * reconciliation against the daemon's REAL active tenancy) and the "switch freeze" fix (bounded
 * switches always clear pending state and offer a Retry that re-issues the exact action).
 *
 * `reconcileScope`/`activeTenancyFromRead` are covered directly (pure, no mount needed); the
 * mounted `ScopeProvider` + `ScopeSwitcherSlot` tests exercise the full reconciliation-on-mount and
 * switch-freeze-recovery flows end to end.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
	activeTenancyFromRead,
	loadPersistedScope,
	reconcileScope,
	SCOPE_STORAGE_KEY,
	ScopeProvider,
	ScopeSwitcherSlot,
	useScopeSwitcher,
	type DashboardScope,
} from "../../src/dashboard/web/scope-context.js";
import type { ScopeOrgWire, ScopeProjectWire, ScopeWorkspaceWire, SetupTenancyResultWire, WireClient } from "../../src/dashboard/web/wire.js";

/**
 * A minimal in-memory `Storage` stand-in, installed via `vi.stubGlobal`. Node's own built-in
 * `globalThis.localStorage` (present unconfigured in this repo's Node runtime, hence the
 * "`--localstorage-file` was provided without a valid path" warning) shadows jsdom's real,
 * functional one and throws on every call, so tests must supply a working implementation
 * explicitly rather than relying on the ambient global.
 */
function createMemoryStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => {
			store.clear();
		},
		key: (index: number) => Array.from(store.keys())[index] ?? null,
		get length() {
			return store.size;
		},
	} as Storage;
}

beforeEach(() => {
	vi.stubGlobal("localStorage", createMemoryStorage());
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function org(id: string): ScopeOrgWire {
	return { id, name: id };
}

function tenancyResult(overrides: Partial<SetupTenancyResultWire> = {}): SetupTenancyResultWire {
	return {
		pending: false,
		selected: true,
		authenticated: true,
		org: { id: "LegionCode", name: "LegionCode" },
		workspace: { id: "default", name: "default" },
		unreachable: false,
		...overrides,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The pure reconciliation rule (no mount needed).
// ─────────────────────────────────────────────────────────────────────────────

describe("reconcileScope (the 'reverts to OSPRY' fix's data-level correction)", () => {
	const enumerated: readonly ScopeOrgWire[] = [org("OSPRY"), org("LegionCode")];

	it("corrects a persisted org NOT among the enumerated list to the REAL active tenancy", () => {
		const current: DashboardScope = { org: "local", workspace: "default" };
		const active = { org: "LegionCode", workspace: "default" };
		expect(reconcileScope(current, enumerated, active)).toEqual({ org: "LegionCode", workspace: "default" });
	});

	it("trusts a persisted org that IS among the enumerated list, even if it differs from active (no active override needed)", () => {
		const current: DashboardScope = { org: "OSPRY", workspace: "default" };
		const active = { org: "LegionCode", workspace: "default" };
		expect(reconcileScope(current, enumerated, active)).toBe(current);
	});

	it("leaves a stale value AS-IS when there is no real active tenancy to correct it to yet", () => {
		const current: DashboardScope = { org: "local", workspace: "default" };
		expect(reconcileScope(current, enumerated, null)).toBe(current);
	});

	it("corrects a missing/empty org unconditionally once an active tenancy is known", () => {
		const current: DashboardScope = { org: "", workspace: "" };
		const active = { org: "LegionCode", workspace: "default" };
		expect(reconcileScope(current, [], active)).toEqual({ org: "LegionCode", workspace: "default" });
	});
});

describe("activeTenancyFromRead", () => {
	it("derives the real org/workspace ids from a confirmed, reachable, authenticated read", () => {
		expect(activeTenancyFromRead(tenancyResult())).toEqual({ org: "LegionCode", workspace: "default" });
	});

	it("returns null when unreachable/unauthenticated/unselected: never fabricates a pair", () => {
		expect(activeTenancyFromRead(tenancyResult({ unreachable: true }))).toBeNull();
		expect(activeTenancyFromRead(tenancyResult({ authenticated: false }))).toBeNull();
		expect(activeTenancyFromRead(tenancyResult({ selected: false }))).toBeNull();
		expect(activeTenancyFromRead(tenancyResult({ org: null }))).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The mounted provider + slot.
// ─────────────────────────────────────────────────────────────────────────────

function baseWire(overrides: Partial<WireClient> = {}): WireClient {
	return {
		scopeOrgs: vi.fn(async (): Promise<ScopeOrgWire[]> => [org("OSPRY"), org("LegionCode")]),
		scopeWorkspaces: vi.fn(async (): Promise<{ workspaces: ScopeWorkspaceWire[]; org: string; reminted: boolean }> => ({
			workspaces: [{ id: "default", name: "default" }],
			org: "LegionCode",
			reminted: false,
		})),
		scopeProjects: vi.fn(async (): Promise<ScopeProjectWire[]> => []),
		setupTenancy: vi.fn(async (): Promise<SetupTenancyResultWire> => tenancyResult()),
		...overrides,
	} as unknown as WireClient;
}

describe("ScopeProvider reconciliation on mount (the 'reverts to OSPRY' fix)", () => {
	it("persisted scope 'local'/stale-id + enumerated [OSPRY, LegionCode] + credential bound to LegionCode renders LegionCode selected, not OSPRY", async () => {
		localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify({ org: "local", workspace: "default" }));

		const wire = baseWire();
		render(
			<ScopeProvider wire={wire}>
				<ScopeSwitcherSlot collapsed={false} />
			</ScopeProvider>,
		);

		await waitFor(() => expect((screen.getByTestId("scope-org") as HTMLSelectElement).value).toBe("LegionCode"));
		expect((screen.getByTestId("scope-org") as HTMLSelectElement).value).not.toBe("OSPRY");
		// The persisted correction sticks across a reload (the reconciled value, not the stale one).
		expect(loadPersistedScope()?.org).toBe("LegionCode");
	});

	it("a persisted org that IS enumerated is trusted and never overridden by the active tenancy read", async () => {
		localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify({ org: "OSPRY", workspace: "default" }));
		const wire = baseWire({ setupTenancy: vi.fn(async () => tenancyResult()) }); // active tenancy says LegionCode

		render(
			<ScopeProvider wire={wire}>
				<ScopeSwitcherSlot collapsed={false} />
			</ScopeProvider>,
		);

		await waitFor(() => expect((screen.getByTestId("scope-org") as HTMLSelectElement).value).toBe("OSPRY"));
	});

	it("never renders a select whose value is absent from its options: an unresolvable stale org shows an honest placeholder, not a silent fallback to the first enumerated org", async () => {
		localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify({ org: "stale-id", workspace: "default" }));
		// Tenancy unreachable: nothing authoritative to correct the stale value TO yet.
		const wire = baseWire({ setupTenancy: vi.fn(async () => tenancyResult({ unreachable: true })) });

		render(
			<ScopeProvider wire={wire}>
				<ScopeSwitcherSlot collapsed={false} />
			</ScopeProvider>,
		);

		await waitFor(() => expect(screen.getByTestId("scope-org").querySelectorAll("option")).toHaveLength(3));
		const select = screen.getByTestId("scope-org") as HTMLSelectElement;
		// Honest: the select shows the genuinely-unresolved value, never OSPRY (the first enumerated org).
		expect(select.value).toBe("stale-id");
		expect(select.value).not.toBe("OSPRY");
		expect(select.querySelector('option[value="stale-id"]')).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ISS-019 — refreshProjects: a bind-completion callback re-enumerates the provider's
// project list (the sidebar switcher's source) without a full reload.
// ─────────────────────────────────────────────────────────────────────────────

/** A probe consumer standing in for a bind flow: reads the list + fires `refreshProjects` on demand. */
function RefreshProjectsProbe(): React.JSX.Element {
	const { projects, refreshProjects } = useScopeSwitcher();
	return (
		<div>
			<span data-testid="probe-project-count">{projects.length}</span>
			<button type="button" data-testid="probe-refresh" onClick={() => void refreshProjects()}>
				refresh
			</button>
		</div>
	);
}

describe("ScopeProvider refreshProjects (ISS-019: stale sidebar after project bind)", () => {
	it("a bind callback's refreshProjects() re-fetches the provider's project list and re-renders the new binding", async () => {
		// The FIRST enumeration (mount) returns no projects; the post-bind refresh returns the new one —
		// exactly the ISS-019 shape: the registry gained a binding AFTER the provider's mount-time load.
		let calls = 0;
		const bound: ScopeProjectWire = {
			projectId: "hive",
			name: "hive",
			boundLocally: true,
			boundPaths: ["C:/repos/hive"],
			remote: "",
			memoryCount: 0,
			sessionCount: 0,
			lastCapture: null,
		} as ScopeProjectWire;
		const wire = baseWire({
			scopeProjects: vi.fn(async (): Promise<ScopeProjectWire[]> => {
				calls += 1;
				return calls === 1 ? [] : [bound];
			}),
		});

		render(
			<ScopeProvider wire={wire}>
				<RefreshProjectsProbe />
			</ScopeProvider>,
		);

		// Mount hydration ran once and honestly shows zero projects.
		await waitFor(() => expect(calls).toBe(1));
		await waitFor(() => expect(screen.getByTestId("probe-project-count").textContent).toBe("0"));

		// The bind flow completes → refreshProjects() re-enumerates and the provider re-renders the list.
		act(() => {
			fireEvent.click(screen.getByTestId("probe-refresh"));
		});
		await waitFor(() => expect(screen.getByTestId("probe-project-count").textContent).toBe("1"));
		expect(calls).toBe(2);
	});
});

describe("ScopeProvider switch freeze fix (bounded switches always clear pending + offer Retry)", () => {
	it("a failed/timed-out org switch clears pending, re-enables the selects, shows a Retry, and Retry re-issues the exact switch", async () => {
		let switchCalls = 0;
		const wire = baseWire({
			switchOrg: vi.fn(async (target: string) => {
				switchCalls += 1;
				// The FIRST attempt simulates the bounded wire layer's timeout fallback (FAILED_ORG_SWITCH_ACK-shaped).
				if (switchCalls === 1) return { switched: false, org: "", reminted: false, error: "unavailable" };
				return { switched: true, org: target, orgName: target, reminted: false };
			}),
		});

		render(
			<ScopeProvider wire={wire}>
				<ScopeSwitcherSlot collapsed={false} />
			</ScopeProvider>,
		);
		await waitFor(() => expect((screen.getByTestId("scope-org") as HTMLSelectElement).value).toBe("LegionCode"));

		act(() => {
			fireEvent.change(screen.getByTestId("scope-org"), { target: { value: "OSPRY" } });
		});

		// While the switch is in flight, every scope select is disabled (never a "stuck open" freeze).
		expect((screen.getByTestId("scope-org") as HTMLSelectElement).disabled).toBe(true);
		expect((screen.getByTestId("scope-workspace") as HTMLSelectElement).disabled).toBe(true);
		expect((screen.getByTestId("scope-project") as HTMLSelectElement).disabled).toBe(true);

		// The bounded wire call resolves (to a failure) rather than hanging: pending clears, an honest
		// error shows, a Retry appears, and every select re-enables.
		await waitFor(() => expect(screen.getByTestId("switch-retry")).toBeTruthy());
		expect(screen.getByTestId("switch-feedback").getAttribute("data-kind")).toBe("error");
		expect(screen.getByTestId("switch-feedback").textContent).toContain("could not switch");
		expect((screen.getByTestId("scope-org") as HTMLSelectElement).disabled).toBe(false);
		expect((screen.getByTestId("scope-workspace") as HTMLSelectElement).disabled).toBe(false);
		expect((screen.getByTestId("scope-project") as HTMLSelectElement).disabled).toBe(false);
		// The failed switch never mutated the active scope; it honestly stayed on the prior org.
		expect((screen.getByTestId("scope-org") as HTMLSelectElement).value).toBe("LegionCode");

		act(() => {
			fireEvent.click(screen.getByTestId("switch-retry"));
		});

		// Retry re-issues the EXACT same action (the org the user originally picked, "OSPRY").
		await waitFor(() => expect(screen.getByTestId("switch-feedback").getAttribute("data-kind")).toBe("persisted"));
		expect(switchCalls).toBe(2);
		expect(wire.switchOrg).toHaveBeenNthCalledWith(2, "OSPRY");
		expect((screen.getByTestId("scope-org") as HTMLSelectElement).value).toBe("OSPRY");
	});

	it("a failed/timed-out workspace switch also clears pending and offers a working Retry", async () => {
		let switchCalls = 0;
		const wire = baseWire({
			// A second enumerated workspace so the `<select>` change event targets a REAL `<option>`
			// (assigning a `<select>`'s value to something absent from its options is ignored by the
			// DOM, which would otherwise mask the bug this test targets behind an empty-string event).
			scopeWorkspaces: vi.fn(async () => ({
				workspaces: [
					{ id: "default", name: "default" },
					{ id: "secondary", name: "secondary" },
				],
				org: "LegionCode",
				reminted: false,
			})),
			switchWorkspace: vi.fn(async (target: string) => {
				switchCalls += 1;
				if (switchCalls === 1) return { switched: false, workspace: "", error: "unavailable" };
				return { switched: true, workspace: target };
			}),
		});

		render(
			<ScopeProvider wire={wire}>
				<ScopeSwitcherSlot collapsed={false} />
			</ScopeProvider>,
		);
		await waitFor(() => expect((screen.getByTestId("scope-org") as HTMLSelectElement).value).toBe("LegionCode"));

		act(() => {
			fireEvent.change(screen.getByTestId("scope-workspace"), { target: { value: "secondary" } });
		});

		await waitFor(() => expect(screen.getByTestId("switch-retry")).toBeTruthy());
		expect(screen.getByTestId("switch-feedback").textContent).toContain("could not switch");
		expect((screen.getByTestId("scope-workspace") as HTMLSelectElement).disabled).toBe(false);

		act(() => {
			fireEvent.click(screen.getByTestId("switch-retry"));
		});

		await waitFor(() => expect(screen.getByTestId("switch-feedback").getAttribute("data-kind")).toBe("persisted"));
		expect(switchCalls).toBe(2);
		expect(wire.switchWorkspace).toHaveBeenNthCalledWith(2, "secondary");
	});
});
