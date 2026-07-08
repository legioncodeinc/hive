/**
 * The Org → Workspace → Project SCOPE context — PRD-050b seam, FILLED by PRD-049e.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 050b carved the seam (a context + a hook + a slot) so the 049e scope switcher could slot into the
 * sidebar WITHOUT reworking `host.ts`/`renderShell`/the shell. 049e FILLS it: a real
 * {@link ScopeProvider} hydrates the switchable Org→Workspace→Project selection from the daemon's
 * loopback enumeration endpoints, the {@link ScopeSwitcherSlot} renders the dropdowns, and every
 * scope-aware page reads the active project via {@link useScope}. The shell stays scope-UNAWARE —
 * scope lives entirely in the React app, never baked into the server-rendered shell.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── The contract (unchanged from 050b — additive only) ──────────────────────
 *   - {@link DashboardScope} `{ org, workspace, project? }` — what a page reads.
 *   - {@link useScope} — the hook every scope-aware surface uses. 049e makes it reactive to the
 *     switcher's selection; a surface written against this hook needs NO change.
 *   - {@link ScopeSwitcherSlot} — the sidebar region. 050b returned null; 049e renders the picker.
 *
 * ── Viewer-side selection (49e-AC-4) ─────────────────────────────────────────
 * The selection drives WHICH data the pages show (it stamps the `x-honeycomb-project` read header).
 * It does NOT overwrite a developer's per-folder CLI bindings: there is NO write to `projects.json`
 * anywhere in this module. The selection is persisted ONLY in `localStorage` (the dashboard session),
 * so a reload restores the last view without touching the registry.
 */

import React from "react";

import type { ScopeOrgWire, ScopeProjectWire, ScopeWorkspaceWire, SetupTenancyResultWire, WireClient } from "./wire.js";
// PRD-012b: clear the SWR cache on a scope switch so every scoped read re-fetches against the new
// org/workspace/project (all scoped keys include the project id, but an org switch re-mints the token
// so even unscoped reads are potentially different — clearSwrCache is the safe broad reset).
import { clearSwrCache } from "./use-swr.js";

/**
 * The active scope the dashboard reads (the 049e contract). `org` is always present; `workspace`
 * and `project` narrow it. 050b shipped the single loopback-local default; 049e makes these
 * switchable from the {@link ScopeSwitcherSlot}.
 */
export interface DashboardScope {
	/** The active org id (always present; the loopback "local" tenant until the switcher selects one). */
	readonly org: string;
	/** The active workspace id (the `default` sentinel until the switcher selects one). */
	readonly workspace: string;
	/** The active project id, when the scope is narrowed to one (049e); absent → no project selected. */
	readonly project?: string;
}

/** The single-scope default the app starts from (the loopback local tenant) until enumeration resolves. */
export const DEFAULT_SCOPE: DashboardScope = Object.freeze({ org: "local", workspace: "default" });

/** The `localStorage` key the dashboard persists its last viewer-side selection under (49e — viewer-side). */
export const SCOPE_STORAGE_KEY = "honeycomb.dashboard.scope" as const;

/** The scope context value — the active scope plus a `setScope` the switcher wires to its dropdowns. */
export interface ScopeContextValue {
	/** The active scope. */
	readonly scope: DashboardScope;
	/**
	 * Switch the active scope (the switcher calls this). The default provider value is a NO-OP (a single,
	 * un-switchable scope) so a surface that calls it outside a {@link ScopeProvider} is harmless; the
	 * real {@link ScopeProvider} replaces it with a setter that re-hydrates the scoped views + persists.
	 */
	readonly setScope: (next: DashboardScope) => void;
}

/** The React context (the 049e mount point). Defaults to the single loopback scope + a no-op setter. */
export const ScopeContext = React.createContext<ScopeContextValue>({
	scope: DEFAULT_SCOPE,
	setScope: () => {
		// No-op default: outside a ScopeProvider there is exactly one scope. The provider replaces this.
	},
});

/**
 * Read the active dashboard scope (the hook every scope-aware surface uses). Reactive to the switcher's
 * selection when rendered inside a {@link ScopeProvider}; returns the single default otherwise. Read
 * scope from HERE, never bake a single-workspace assumption into a page or the shell.
 */
export function useScope(): ScopeContextValue {
	return React.useContext(ScopeContext);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-049e — the switcher data context (the enumeration state + dropdown handlers).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The switcher's enumeration state + handlers (PRD-049e). Separate from {@link ScopeContextValue} so a
 * page reads only the lean `{ scope, setScope }` it needs, while the {@link ScopeSwitcherSlot} reads
 * this richer surface. The {@link ScopeProvider} owns both; the slot reads this via {@link useScopeSwitcher}.
 */
export interface ScopeSwitcherValue {
	/** The orgs the user can access (privilege-scoped by the daemon — 49e-AC-1). */
	readonly orgs: readonly ScopeOrgWire[];
	/** The selected org's workspaces (re-enumerated on org change, after the re-mint — 49e-AC-3). */
	readonly workspaces: readonly ScopeWorkspaceWire[];
	/** The workspace's registry projects (the 049a synced copy, incl. the `__unsorted__` inbox). */
	readonly projects: readonly ScopeProjectWire[];
	/**
	 * True once the FIRST projects enumeration has resolved (PRD-059b). The first-run "pick a folder"
	 * CTA keys off this so it never flashes before the projects read returns — only AFTER the read
	 * resolves with zero locally-bound projects does the CTA show (b-AC-1).
	 */
	readonly projectsHydrated: boolean;
	/** True while an org change is re-minting + re-enumerating (the workspace dropdown shows a loading hint). */
	readonly loadingWorkspaces: boolean;
	/**
	 * True while ANY switch (org or workspace) is in flight: gates the org/workspace/project
	 * `<select>`s so they re-disable during a switch and RE-ENABLE the moment the bounded wire call
	 * resolves, whether that resolution is a success or a bounded timeout/failure (the "switch
	 * freeze" fix: previously only `loadingWorkspaces` gated the workspace select, and an unbounded
	 * wire call could leave it disabled forever on one stalled gateway hop).
	 */
	readonly switching: boolean;
	/**
	 * IRD-122 — the last switch's outcome feedback (122-AC-4: no switch is a silent no-op). `null` until a
	 * switch runs; then a `{ kind: "persisted" | "view" | "error", message }` the switcher surfaces so the
	 * user always sees whether a selection PERSISTED a real scope change, is a VIEW filter, or FAILED.
	 */
	readonly switchFeedback: SwitchFeedback | null;
	/**
	 * The exact failed switch action re-issued (the "switch freeze" fix's Retry affordance), `null`
	 * when there is nothing to retry (no switch has failed, or a later switch superseded it).
	 * {@link ScopeSwitcherSlot} renders a Retry control bound to this when `switchFeedback.kind` is
	 * `"error"`.
	 */
	readonly retrySwitch: (() => void) | null;
	/**
	 * Select an org → PERSIST a real org switch via the daemon (re-mint + save to credentials.json —
	 * 122-AC-2), then re-enumerate workspaces; clears the workspace/project. Surfaces persisted/error
	 * feedback (122-AC-4). A failed persist does NOT silently change the view.
	 */
	readonly selectOrg: (org: string) => void;
	/** Select a workspace → PERSIST the workspace switch via the daemon (IRD-122), then re-enumerate projects. */
	readonly selectWorkspace: (workspace: string) => void;
	/**
	 * Select a project → re-scope the pages (VIEW filter only; viewer-side, no registry write — 49e-AC-4
	 * / 122-AC-3). Surfaces "view filter" feedback so the user understands the project dropdown changes
	 * the VIEW, not where capture is written (that is folder/binding-driven — PRD-059).
	 */
	readonly selectProject: (project: string | undefined) => void;
}

/** IRD-122 — the outcome of the last switcher action, surfaced so no change is a silent no-op (122-AC-4). */
export interface SwitchFeedback {
	/** `persisted` = a real org/workspace scope change saved to credentials.json; `view` = a project view filter; `error` = the switch failed. */
	readonly kind: "persisted" | "view" | "error";
	/** A short human message the switcher renders (e.g. "switched to Acme", "view filter", "could not switch"). */
	readonly message: string;
	/** True while the switch is in flight (the org re-mint loading state — 122-AC-4 surfaces it). */
	readonly pending?: boolean;
}

/** The default switcher value (empty enumeration + no-op handlers) — used outside a {@link ScopeProvider}. */
const DEFAULT_SWITCHER: ScopeSwitcherValue = Object.freeze({
	orgs: [],
	workspaces: [],
	projects: [],
	projectsHydrated: false,
	loadingWorkspaces: false,
	switching: false,
	switchFeedback: null,
	retrySwitch: null,
	selectOrg: () => {},
	selectWorkspace: () => {},
	selectProject: () => {},
});

/** The switcher-data context (the enumeration + dropdown handlers). The slot reads it; pages do not. */
export const ScopeSwitcherContext = React.createContext<ScopeSwitcherValue>(DEFAULT_SWITCHER);

/** Read the switcher's enumeration state + handlers (the {@link ScopeSwitcherSlot} uses this). */
export function useScopeSwitcher(): ScopeSwitcherValue {
	return React.useContext(ScopeSwitcherContext);
}

/**
 * Read the persisted viewer-side selection from `localStorage` (49e — persistence is acceptable, and
 * viewer-side: a read of the dashboard's own store, never the registry). Fail-soft: a missing/malformed
 * value yields `null` (the provider then resolves from the daemon default), never a throw.
 */
export function loadPersistedScope(): DashboardScope | null {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(SCOPE_STORAGE_KEY);
		if (raw === null || raw === "") return null;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		const org = typeof obj.org === "string" ? obj.org : "";
		const workspace = typeof obj.workspace === "string" ? obj.workspace : "";
		if (org === "" || workspace === "") return null;
		const project = typeof obj.project === "string" && obj.project !== "" ? obj.project : undefined;
		return project !== undefined ? { org, workspace, project } : { org, workspace };
	} catch {
		return null;
	}
}

/** Persist the viewer-side selection to `localStorage` (49e). Fail-soft — a storage error is swallowed intentionally. */
export function persistScope(scope: DashboardScope): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify(scope));
	} catch {
		// localStorage may be unavailable (private mode / quota). The selection still works in-memory;
		// only the cross-reload persistence is lost — never a thrown error into React.
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The "reverts to OSPRY" display-desync fix: the persisted/current scope is reconciled against
// the daemon's REAL active tenancy (the credential `wire.setupTenancy()` reads), never left to
// drift silently. Pure + exported so the reconciliation rule itself is unit-testable without
// mounting the provider.
// ─────────────────────────────────────────────────────────────────────────────

/** The daemon's REAL active org/workspace pair (derived from a {@link SetupTenancyResultWire} read). */
export interface ActiveTenancy {
	readonly org: string;
	readonly workspace: string;
}

/**
 * Derive the REAL active org/workspace ids from a tenancy read, or `null` when there is nothing
 * authoritative to reconcile against (unreachable, not authenticated, not yet selected, or a body
 * missing either id). Never fabricates a pair from a partial read.
 */
export function activeTenancyFromRead(read: SetupTenancyResultWire): ActiveTenancy | null {
	if (read.unreachable || !read.authenticated || !read.selected) return null;
	const org = read.org?.id ?? "";
	const workspace = read.workspace?.id ?? "";
	if (org === "" || workspace === "") return null;
	return { org, workspace };
}

/**
 * Reconcile `current` against the enumerated orgs + the REAL active tenancy (the fix for the
 * "reverts to OSPRY" desync): the org/workspace switcher previously bound `value={scope.org}` to
 * localStorage state and never reconciled it with the credential's real org, so a persisted value
 * that matched no enumerated `<option>` made the native `<select>` VISUALLY fall back to the first
 * option (whichever org happened to sort first), looking like a revert while the real bound org
 * was actually unchanged underneath.
 *
 * `current` is trusted (returned unchanged) UNLESS it is genuinely stale: missing (`""`) or absent
 * from the enumerated org list once that list has loaded (`orgs.length > 0`). Only then is it
 * corrected: to `active`, the credential's real bound org/workspace, never to an enumerated org
 * that merely happens to sort first. When `active` is `null` (tenancy unreachable/unselected) a
 * stale value is left as-is: there is nothing authoritative to correct it TO yet, and the
 * placeholder-option rendering in {@link ScopeSwitcherSlot} keeps the `<select>` honest in the
 * meantime (never silently shows the wrong org as selected).
 */
export function reconcileScope(current: DashboardScope, orgs: readonly ScopeOrgWire[], active: ActiveTenancy | null): DashboardScope {
	const isStaleOrMissing = current.org === "" || (orgs.length > 0 && !orgs.some((o) => o.id === current.org));
	if (!isStaleOrMissing || active === null) return current;
	return { org: active.org, workspace: active.workspace };
}

/**
 * The SCOPE PROVIDER (PRD-049e) — owns the switchable selection + the enumeration state, and feeds both
 * the lean {@link ScopeContext} (pages) and the rich {@link ScopeSwitcherContext} (the slot). Mounted by
 * the {@link import("./app.js").Shell} around the sidebar + outlet, so every page + the switcher share
 * ONE source of truth.
 *
 * On mount it hydrates the orgs (privilege-scoped), then the workspaces + projects for the
 * resolved/persisted org, and restores the persisted project selection (viewer-side). Selecting an Org
 * re-enumerates workspaces (the daemon re-mints the org-bound token FIRST — 49e-AC-3); selecting a
 * Workspace re-enumerates projects; selecting a Project re-scopes the pages (the project flows into
 * `useScope().scope.project`, which the pages thread into the wire fetchers). NO write to `projects.json`
 * happens here — the selection is purely viewer-side (49e-AC-4).
 */
export function ScopeProvider({ wire, children }: { wire: WireClient; children: React.ReactNode }): React.JSX.Element {
	const persisted = React.useMemo(() => loadPersistedScope(), []);
	const [scope, setScopeState] = React.useState<DashboardScope>(persisted ?? DEFAULT_SCOPE);
	const [orgs, setOrgs] = React.useState<readonly ScopeOrgWire[]>([]);
	const [workspaces, setWorkspaces] = React.useState<readonly ScopeWorkspaceWire[]>([]);
	const [projects, setProjects] = React.useState<readonly ScopeProjectWire[]>([]);
	const [projectsHydrated, setProjectsHydrated] = React.useState(false);
	const [loadingWorkspaces, setLoadingWorkspaces] = React.useState(false);
	// IRD-122 (122-AC-4): the last switch's outcome, so no switcher change is ever a silent no-op.
	const [switchFeedback, setSwitchFeedback] = React.useState<SwitchFeedback | null>(null);
	// The "switch freeze" fix's Retry affordance: the exact action to re-issue on a failed switch.
	const [retrySwitch, setRetrySwitch] = React.useState<(() => void) | null>(null);

	/** Commit a new scope: persist it (viewer-side) + update state so pages re-render against it. */
	const commitScope = React.useCallback((next: DashboardScope): void => {
		setScopeState(next);
		persistScope(next);
		// PRD-012b: every scope switch potentially changes every scoped read (org switch re-mints the
		// token; workspace/project switch changes the project header). Clear the SWR cache so the next
		// read reflects the new scope — no stale cross-scope data renders for one frame.
		clearSwrCache();
	}, []);

	/** Reconcile `current` against `orgs` + the REAL active tenancy; persist + commit only on an actual correction. */
	const reconcileAgainstTenancy = React.useCallback((freshOrgs: readonly ScopeOrgWire[], active: ActiveTenancy | null): void => {
		setScopeState((current) => {
			const reconciled = reconcileScope(current, freshOrgs, active);
			if (reconciled !== current) persistScope(reconciled);
			return reconciled;
		});
	}, []);

	// The setScope a page would call (e.g. a deep link). Persists + re-renders; no enumeration side effect.
	const setScope = React.useCallback((next: DashboardScope): void => commitScope(next), [commitScope]);

	/** Enumerate a workspace's projects (sets the hydrated flag so the 059b first-run CTA can key off it). */
	const loadProjects = React.useCallback(async (): Promise<void> => {
		const rows = await wire.scopeProjects();
		setProjects(rows);
		setProjectsHydrated(true);
	}, [wire]);

	// Hydrate orgs once on mount (49e-AC-1), reading the REAL active tenancy alongside them so the
	// persisted/default scope can be reconciled immediately (the "reverts to OSPRY" fix: 49e-AC-1 +
	// the tenancy read never ran together before, so a stale/unenumerated persisted org silently
	// desynced the switcher from the credential's real bound org).
	React.useEffect(() => {
		let alive = true;
		void (async () => {
			const [rows, tenancy] = await Promise.all([wire.scopeOrgs(), wire.setupTenancy()]);
			if (!alive) return;
			setOrgs(rows);
			reconcileAgainstTenancy(rows, activeTenancyFromRead(tenancy));
		})();
		// Also hydrate the workspaces + projects for the initial (persisted/default) org so the dropdowns
		// are populated on first render without requiring an org re-select. `scopeWorkspaces()` with no
		// `org` argument enumerates the DAEMON's current credential org (the real active one), so this
		// already agrees with the tenancy read above regardless of what the (possibly stale) persisted
		// scope says.
		void (async () => {
			const ws = await wire.scopeWorkspaces();
			if (!alive) return;
			setWorkspaces(ws.workspaces);
		})();
		void loadProjects();
		return () => {
			alive = false;
		};
	}, [wire, loadProjects, reconcileAgainstTenancy]);

	// Reconcile again after any switch COMPLETES (persisted, not pending): the fix's "on mount AND
	// after any switch completes" requirement. A successful switch's `commitScope` already reflects
	// the just-persisted ack, so this is a defensive re-read of the credential's ground truth (mirrors
	// `ActiveTenancyDisplay`'s own tv-AC-5 re-hydrate-after-switch pattern) rather than a load-bearing
	// correction on the happy path.
	React.useEffect(() => {
		if (switchFeedback?.kind !== "persisted" || switchFeedback.pending === true) return;
		let alive = true;
		void (async () => {
			const tenancy = await wire.setupTenancy();
			if (!alive) return;
			reconcileAgainstTenancy(orgs, activeTenancyFromRead(tenancy));
		})();
		return () => {
			alive = false;
		};
	}, [switchFeedback, wire, orgs, reconcileAgainstTenancy]);

	// IRD-122 (122-AC-1 / 122-AC-2): selecting an org now PERSISTS a real org switch via the daemon
	// (re-mint the org-bound token + save to credentials.json — the SAME mechanic as `honeycomb org
	// switch`), THEN re-enumerates the new org's workspaces. The switch is no longer viewer-only: on
	// success `whoami` reflects it. Feedback is surfaced (122-AC-4) — pending while re-minting, then
	// persisted or error; a FAILED persist does NOT silently change the dashboard view (we keep the prior
	// scope so the control never lies about what is active).
	//
	// "Switch freeze" fix: every wire call this makes (`switchOrg`, `scopeWorkspaces`) is now bounded
	// (see `wire.ts`'s `SCOPE_REQUEST_TIMEOUT_MS`), so this `async` IIFE always settles; the `finally`
	// always runs, `loadingWorkspaces` always clears, and a failure surfaces an honest error with a
	// `retrySwitch` that re-issues this EXACT call rather than leaving the control disabled forever.
	const runOrgSwitch = React.useCallback(
		(org: string): void => {
			setRetrySwitch(null);
			setLoadingWorkspaces(true);
			setSwitchFeedback({ kind: "persisted", message: "switching org…", pending: true });
			void (async () => {
				try {
					const ack = await wire.switchOrg(org);
					if (!ack.switched) {
						// The persist failed (no credential / unknown org / re-mint error / a bounded timeout).
						// Surface it; do NOT mutate the active scope (the switcher honestly reflects that
						// nothing changed), and offer a Retry that re-issues this exact org switch.
						setSwitchFeedback({ kind: "error", message: ack.error !== undefined && ack.error !== "" ? `could not switch: ${ack.error}` : "could not switch org" });
						setRetrySwitch(() => () => runOrgSwitch(org));
						return;
					}
					// Persisted (re-minted if the org changed). Commit the view to the now-active org + reset the
					// workspace (a concrete workspace belonged to the previous org), then re-enumerate.
					commitScope({ org: ack.org, workspace: DEFAULT_SCOPE.workspace, project: undefined });
					const ws = await wire.scopeWorkspaces(ack.org);
					setWorkspaces(ws.workspaces);
					setProjects([]);
					setProjectsHydrated(true);
					setSwitchFeedback({ kind: "persisted", message: ack.reminted ? `switched to ${ack.orgName ?? ack.org} · re-minted` : `switched to ${ack.orgName ?? ack.org}` });
				} catch {
					// Every wire call above is fail-soft by construction and should never throw; this is a
					// last-resort net so an unforeseen exception still clears the pending state honestly
					// rather than leaving the switcher wedged.
					setSwitchFeedback({ kind: "error", message: "could not switch org" });
					setRetrySwitch(() => () => runOrgSwitch(org));
				} finally {
					setLoadingWorkspaces(false);
				}
			})();
		},
		[wire, commitScope],
	);
	const selectOrg = runOrgSwitch;

	// IRD-122: selecting a workspace PERSISTS the workspace switch via the daemon (write the workspace id
	// to credentials.json — no re-mint), THEN re-enumerates its projects. Failure is surfaced, never silent.
	// "Switch freeze" fix: `switchWorkspace` + `scopeProjects` (via `loadProjects`) are both bounded, and a
	// Retry re-issues this exact workspace switch.
	const runWorkspaceSwitch = React.useCallback(
		(workspace: string): void => {
			setRetrySwitch(null);
			setSwitchFeedback({ kind: "persisted", message: "switching workspace…", pending: true });
			void (async () => {
				try {
					const ack = await wire.switchWorkspace(workspace);
					if (!ack.switched) {
						setSwitchFeedback({ kind: "error", message: ack.error !== undefined && ack.error !== "" ? `could not switch: ${ack.error}` : "could not switch workspace" });
						setRetrySwitch(() => () => runWorkspaceSwitch(workspace));
						return;
					}
					commitScope({ org: scope.org, workspace: ack.workspace, project: undefined });
					await loadProjects();
					setSwitchFeedback({ kind: "persisted", message: `switched to ${ack.workspace}` });
				} catch {
					setSwitchFeedback({ kind: "error", message: "could not switch workspace" });
					setRetrySwitch(() => () => runWorkspaceSwitch(workspace));
				}
			})();
		},
		[wire, commitScope, scope.org, loadProjects],
	);
	const selectWorkspace = runWorkspaceSwitch;

	// Gates the org/workspace/project `<select>`s: true while an org switch is re-minting/re-enumerating
	// OR any switch's feedback is still `pending` (the "switch freeze" fix: both flags are now always
	// bounded, so this can never stay true past SCOPE_REQUEST_TIMEOUT_MS).
	const switching = loadingWorkspaces || switchFeedback?.pending === true;

	// 122-AC-3: the project dropdown is a VIEW FILTER. Selecting a project re-scopes the pages
	// (viewer-side; NO registry write — 49e-AC-4) and surfaces "view filter" feedback so the user
	// understands it changes the VIEW, not where capture is written (that is folder/binding-driven —
	// PRD-059). `undefined` clears the selection (the needs-selection empty state, 49e-AC-5).
	const selectProject = React.useCallback(
		(project: string | undefined): void => {
			commitScope({ org: scope.org, workspace: scope.workspace, ...(project !== undefined ? { project } : {}) });
			setSwitchFeedback({ kind: "view", message: project !== undefined ? "view filter — capture is set by folder binding" : "view cleared" });
		},
		[commitScope, scope.org, scope.workspace],
	);

	const scopeValue = React.useMemo<ScopeContextValue>(() => ({ scope, setScope }), [scope, setScope]);
	const switcherValue = React.useMemo<ScopeSwitcherValue>(
		() => ({
			orgs,
			workspaces,
			projects,
			projectsHydrated,
			loadingWorkspaces,
			switching,
			switchFeedback,
			retrySwitch,
			selectOrg,
			selectWorkspace,
			selectProject,
		}),
		[orgs, workspaces, projects, projectsHydrated, loadingWorkspaces, switching, switchFeedback, retrySwitch, selectOrg, selectWorkspace, selectProject],
	);

	return (
		<ScopeContext.Provider value={scopeValue}>
			<ScopeSwitcherContext.Provider value={switcherValue}>{children}</ScopeSwitcherContext.Provider>
		</ScopeContext.Provider>
	);
}

/** Props for {@link ScopeSwitcherSlot}. `collapsed` mirrors the sidebar's rail state for the compact switcher. */
export interface ScopeSwitcherSlotProps {
	/** Whether the sidebar is in its collapsed icon-rail (renders a compact, label-free switcher). */
	readonly collapsed: boolean;
}

/** The shared `<select>` styling for the switcher dropdowns (existing DS tokens only — no new token). */
const SELECT_STYLE: React.CSSProperties = {
	width: "100%",
	height: 30,
	padding: "0 8px",
	background: "var(--bg-elevated)",
	border: "1px solid var(--border-default)",
	borderRadius: "var(--radius-md)",
	color: "var(--text-secondary)",
	fontFamily: "var(--font-mono)",
	fontSize: 12,
	cursor: "pointer",
};

/** One labeled dropdown row in the switcher (a mono caption + a `<select>`). */
function SwitcherSelect({
	label,
	testId,
	value,
	disabled,
	onChange,
	children,
}: {
	label: string;
	testId: string;
	value: string;
	disabled?: boolean;
	onChange: (value: string) => void;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
				{label}
			</span>
			<select
				data-testid={testId}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
				style={{ ...SELECT_STYLE, opacity: disabled ? 0.6 : 1 }}
			>
				{children}
			</select>
		</label>
	);
}

/** The reserved inbox project id (mirrored from the resolver; a literal so this stays a thin-client view). */
const UNSORTED_PROJECT_ID = "__unsorted__" as const;

/** The `<option>` value the project `<select>` uses for "no project selected" (the needs-selection state). */
const NO_PROJECT_VALUE = "" as const;

/**
 * The Org→Workspace→Project SWITCHER (PRD-049e) — the body that fills the 050b slot. Three dependent
 * dropdowns hydrated from the {@link useScopeSwitcher} enumeration state; the active selection comes from
 * {@link useScope}. Changing the Org re-enumerates workspaces (after the daemon re-mints — 49e-AC-3),
 * changing the Workspace re-enumerates projects, and changing the Project re-scopes every page
 * (viewer-side; no registry write — 49e-AC-4). In the collapsed rail it renders nothing (the switcher
 * needs labels) — the sidebar expands to switch scope.
 */
export function ScopeSwitcherSlot({ collapsed }: ScopeSwitcherSlotProps): React.JSX.Element | null {
	const { scope } = useScope();
	const switcher = useScopeSwitcher();

	// The collapsed icon-rail has no room for three labeled dropdowns; render nothing (the expanded rail
	// is where scope is switched). This keeps the collapsed layout identical to 050b.
	if (collapsed) return null;

	// The "reverts to OSPRY" fix's UI-level safety net: a `<select>` must NEVER render with a `value`
	// that matches none of its `<option>`s (the native element silently falls back to the first
	// option, looking like the wrong tenant is active). Once an enumeration has actually loaded
	// (`options.length > 0`) and the current value is not among the known ids, an explicit disabled
	// placeholder option is inserted FOR that value, so the select stays honest (shows the genuinely
	// unresolved value, not a fabricated "first in the list") while `reconcileScope` (see
	// `scope-context.tsx`'s module doc) corrects the underlying state as soon as the real tenancy
	// resolves.
	const orgUnresolved = switcher.orgs.length > 0 && !switcher.orgs.some((o) => o.id === scope.org);
	const workspaceUnresolved = switcher.workspaces.length > 0 && !switcher.workspaces.some((w) => w.id === scope.workspace);

	return (
		<div data-testid="scope-switcher" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<SwitcherSelect label="org" testId="scope-org" value={scope.org} disabled={switcher.switching} onChange={switcher.selectOrg}>
				{/* The active org is always offered, even before the enumeration resolves, so the control never
				    renders blank (the resolved/persisted scope shows immediately). */}
				{switcher.orgs.length === 0 && <option value={scope.org}>{scope.org}</option>}
				{orgUnresolved && (
					<option value={scope.org} disabled>
						{scope.org === "" ? "(unresolved)" : `${scope.org} (unresolved)`}
					</option>
				)}
				{switcher.orgs.map((o) => (
					<option key={o.id} value={o.id}>
						{o.name !== "" ? o.name : o.id}
					</option>
				))}
			</SwitcherSelect>

			<SwitcherSelect
				label="workspace"
				testId="scope-workspace"
				value={scope.workspace}
				disabled={switcher.switching}
				onChange={switcher.selectWorkspace}
			>
				{switcher.workspaces.length === 0 && <option value={scope.workspace}>{switcher.loadingWorkspaces ? "loading…" : scope.workspace}</option>}
				{workspaceUnresolved && (
					<option value={scope.workspace} disabled>
						{scope.workspace === "" ? "(unresolved)" : `${scope.workspace} (unresolved)`}
					</option>
				)}
				{switcher.workspaces.map((w) => (
					<option key={w.id} value={w.id}>
						{w.name !== "" ? w.name : w.id}
					</option>
				))}
			</SwitcherSelect>

			{/* IRD-122 (122-AC-3): the project dropdown is explicitly a VIEW FILTER — it cannot set capture
			    scope (that is folder/binding-driven via PRD-059). The label + caption say so unambiguously so a
			    user never reads it as "capture here". */}
			<SwitcherSelect
				label="project · view filter"
				testId="scope-project"
				value={scope.project ?? NO_PROJECT_VALUE}
				disabled={switcher.switching}
				onChange={(v) => switcher.selectProject(v === NO_PROJECT_VALUE ? undefined : v)}
			>
				{/* The needs-selection sentinel (49e-AC-5): with nothing selected the pages render the
				    needs-selection empty state, never another project's data. */}
				<option value={NO_PROJECT_VALUE}>— select a project —</option>
				{switcher.projects.map((p) => (
					<option key={p.projectId} value={p.projectId}>
						{p.projectId === UNSORTED_PROJECT_ID ? "(unsorted inbox)" : p.name !== "" ? p.name : p.projectId}
					</option>
				))}
			</SwitcherSelect>
			<span data-testid="project-view-hint" style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.4 }}>
				Filters what you VIEW. To set where Honeycomb captures, bind a folder in Projects.
			</span>

			{/* IRD-122 (122-AC-4): every switch surfaces feedback — no change is a silent no-op. A persisted
			    org/workspace switch (saved to credentials.json), a project view-filter change, or a failure
			    each show here, distinctly toned. */}
			{switcher.switchFeedback !== null && (
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span
						data-testid="switch-feedback"
						data-kind={switcher.switchFeedback.kind}
						style={{
							fontFamily: "var(--font-mono)",
							fontSize: 10,
							color:
								switcher.switchFeedback.kind === "error"
									? "var(--severity-critical)"
									: switcher.switchFeedback.kind === "persisted"
										? "var(--verified)"
										: "var(--text-tertiary)",
						}}
					>
						{switcher.switchFeedback.pending === true ? "⟳ " : switcher.switchFeedback.kind === "persisted" ? "✓ " : ""}
						{switcher.switchFeedback.message}
					</span>
					{/* "Switch freeze" fix: a failed (incl. timed-out) switch always offers a Retry that
					    re-issues the EXACT same action: no dead-end error with no way forward. */}
					{switcher.switchFeedback.kind === "error" && switcher.retrySwitch !== null && (
						<button
							type="button"
							data-testid="switch-retry"
							onClick={() => switcher.retrySwitch?.()}
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 10,
								color: "var(--text-secondary)",
								background: "var(--bg-elevated)",
								border: "1px solid var(--border-default)",
								borderRadius: "var(--radius-sm)",
								padding: "1px 6px",
								cursor: "pointer",
							}}
						>
							Retry
						</button>
					)}
				</div>
			)}
		</div>
	);
}
