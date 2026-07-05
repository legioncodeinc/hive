/**
 * PRD-011a: the mandatory org + workspace selection step in the onboarding flow.
 * Enters after device-code login succeeds; terminal handoff runs only after `selected: true`.
 */

import React from "react";

import { Button } from "../primitives.js";
import type { OnboardingClient } from "./onboarding-client.js";
import { createTenancyClient, isTenancyRequestFailure, type TenancyClient } from "./tenancy-client.js";
import type { TenancyEntityWire } from "./tenancy-contracts.js";

type StepView =
	| { readonly kind: "loading" }
	| { readonly kind: "org-list"; readonly orgs: readonly TenancyEntityWire[] }
	| { readonly kind: "org-confirm"; readonly org: TenancyEntityWire }
	| {
			readonly kind: "workspace-list";
			readonly org: TenancyEntityWire;
			readonly workspaces: readonly TenancyEntityWire[];
			readonly canCreate: boolean;
	  }
	// Bounded-failure states (client robustness): `onRetry` REISSUES the exact request that
	// failed/timed out (never just dismisses), and `onBack` optionally offers a way back to the
	// organization list so a workspace-load failure is never a dead end.
	| { readonly kind: "error"; readonly message: string; readonly onRetry: () => void; readonly onBack?: () => void }
	| { readonly kind: "split-brain" };

/**
 * W-4 loop-breaker: how many CONSECUTIVE automatic short-circuits (hydrate reads `selected: true`
 * and the step auto-navigates to `/`) are allowed before the step stops reloading and renders a
 * terminal manual state. In the split-brain fault (the browser's proxied tenancy read says
 * selected while the gate's server-side read persistently fails), each auto-navigation bounces
 * off the gate straight back here; without a bound that is an infinite reload loop re-firing
 * `dashboard_reached` and `POST /api/onboarding/complete` every lap.
 */
export const TENANCY_AUTO_COMPLETE_LIMIT = 2 as const;

/** Session-scoped (per-tab) counter key; survives the full page navigations each loop lap makes. */
const AUTO_COMPLETE_COUNT_KEY = "hive.onboarding.tenancy.autoCompleteCount" as const;

function readAutoCompleteCount(): number {
	try {
		if (typeof sessionStorage === "undefined") return 0;
		const raw = sessionStorage.getItem(AUTO_COMPLETE_COUNT_KEY);
		const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
	} catch {
		return 0;
	}
}

function writeAutoCompleteCount(count: number): void {
	try {
		if (typeof sessionStorage === "undefined") return;
		if (count <= 0) sessionStorage.removeItem(AUTO_COMPLETE_COUNT_KEY);
		else sessionStorage.setItem(AUTO_COMPLETE_COUNT_KEY, String(count));
	} catch {
		// Storage unavailable (private mode / quota): the bound degrades to per-mount behavior;
		// never a throw into React.
	}
}

/**
 * Consume one lap of the bounded auto short-circuit allowance. Returns true (and records the lap)
 * while within {@link TENANCY_AUTO_COMPLETE_LIMIT}; returns false once exceeded, at which point
 * the caller must stop auto-navigating and surface the terminal split-brain state. Shared with
 * the tokenless resume probe in `onboarding-screen.tsx`, the other automatic navigator on the
 * split-brain lap.
 */
export function consumeTenancyAutoComplete(): boolean {
	const laps = readAutoCompleteCount() + 1;
	if (laps > TENANCY_AUTO_COMPLETE_LIMIT) return false;
	writeAutoCompleteCount(laps);
	return true;
}

/** Reset the auto short-circuit counter (a live picker flow or an explicit operator action). */
export function resetTenancyAutoComplete(): void {
	writeAutoCompleteCount(0);
}

export interface TenancyStepProps {
	readonly onboardingClient: OnboardingClient;
	readonly tenancyClient?: TenancyClient;
	readonly onComplete?: () => void;
}

function entityLabel(entity: TenancyEntityWire): string {
	return entity.name !== "" ? entity.name : entity.id;
}

export function TenancyStep({ onboardingClient, tenancyClient: tenancyOverride, onComplete }: TenancyStepProps): React.JSX.Element {
	const tenancy = React.useMemo<TenancyClient>(() => tenancyOverride ?? createTenancyClient(), [tenancyOverride]);

	const [view, setView] = React.useState<StepView>({ kind: "loading" });
	const [busy, setBusy] = React.useState(false);
	const [selectError, setSelectError] = React.useState<string | null>(null);
	// The bounded action (select or create) that produced `selectError`, so the Retry affordance
	// below ACTUALLY re-issues the failed request rather than merely dismissing the message.
	const [selectErrorRetry, setSelectErrorRetry] = React.useState<(() => void) | null>(null);
	const [createName, setCreateName] = React.useState("");
	const [showCreate, setShowCreate] = React.useState(false);

	const shownEventRef = React.useRef(false);
	const singleOrgConfirmRef = React.useRef(false);
	const orgCountRef = React.useRef(0);

	const completeFlow = React.useCallback((): void => {
		onboardingClient.sendEvent("dashboard_reached");
		void (async (): Promise<void> => {
			await onboardingClient.complete();
			if (onComplete !== undefined) {
				onComplete();
				return;
			}
			if (typeof window !== "undefined") window.location.assign("/");
		})();
	}, [onboardingClient, onComplete]);

	const loadOrgs = React.useCallback(async (): Promise<void> => {
		setView({ kind: "loading" });
		setSelectError(null);
		setSelectErrorRetry(null);
		// Bounded by TENANCY_REQUEST_TIMEOUT_MS inside the client (AbortController): this await
		// always settles, so "Loading your organizations…" can never spin forever, even on a
		// stalled gateway. A failed/timed-out read degrades to the fail-soft default (selected:
		// false), which correctly falls through to the org list attempt below.
		const status = await tenancy.setupTenancy();
		if (!isTenancyRequestFailure(status) && status.selected) {
			// W-4: bound the automatic short-circuit. Each auto-navigation consumes one lap of the
			// per-tab allowance; past the limit the step stops reloading and renders the terminal
			// manual state instead, breaking the split-brain reload loop deterministically.
			if (!consumeTenancyAutoComplete()) {
				setView({ kind: "split-brain" });
				return;
			}
			completeFlow();
			return;
		}
		// The normal picker flow is live: only CONSECUTIVE auto short-circuits count toward the
		// bound, so a later legitimate pass through this step starts from a clean counter.
		resetTenancyAutoComplete();
		const orgsBody = await tenancy.listOrgs();
		if (isTenancyRequestFailure(orgsBody)) {
			// A timeout or network failure, never a genuine "zero orgs" read: an honest, clearly
			// retryable state instead of the misleading "no organizations" message below.
			setView({
				kind: "error",
				message: "Could not load your organizations. Check your connection and retry.",
				onRetry: () => void loadOrgs(),
			});
			return;
		}
		orgCountRef.current = orgsBody.orgs.length;
		if (orgsBody.orgs.length === 0) {
			setView({
				kind: "error",
				message: "No organizations are available for this account. Check your Deeplake credential and retry.",
				onRetry: () => void loadOrgs(),
			});
			return;
		}
		if (orgsBody.orgs.length === 1) {
			singleOrgConfirmRef.current = true;
			setView({ kind: "org-confirm", org: orgsBody.orgs[0]! });
			return;
		}
		setView({ kind: "org-list", orgs: orgsBody.orgs });
	}, [tenancy, completeFlow]);

	React.useEffect(() => {
		if (shownEventRef.current) return;
		shownEventRef.current = true;
		onboardingClient.sendEvent("tenancy_shown");
	}, [onboardingClient]);

	React.useEffect(() => {
		void loadOrgs();
	}, [loadOrgs]);

	const openWorkspaces = React.useCallback(
		async (org: TenancyEntityWire): Promise<void> => {
			setBusy(true);
			setSelectError(null);
			setSelectErrorRetry(null);
			setShowCreate(false);
			setCreateName("");
			// Bounded by TENANCY_REQUEST_TIMEOUT_MS: this await always settles, so the workspace
			// load can never leave the picker busy forever.
			const ws = await tenancy.listWorkspaces(org.id);
			setBusy(false);
			if (isTenancyRequestFailure(ws)) {
				setView({
					kind: "error",
					message: "Could not load workspaces for this organization. Check your connection and retry.",
					onRetry: () => void openWorkspaces(org),
					onBack: () => void loadOrgs(),
				});
				return;
			}
			setView({
				kind: "workspace-list",
				org,
				workspaces: ws.workspaces,
				canCreate: ws.canCreate,
			});
		},
		[tenancy, loadOrgs],
	);

	const persistSelection = React.useCallback(
		async (org: TenancyEntityWire, workspace: TenancyEntityWire): Promise<void> => {
			setBusy(true);
			setSelectError(null);
			setSelectErrorRetry(null);
			// Bounded by TENANCY_REQUEST_TIMEOUT_MS: this await always settles (a stalled select
			// call can never leave the picker busy forever).
			const ack = await tenancy.selectTenancy(org.id, workspace.id);
			setBusy(false);
			if (ack === null || ack.selected === false) {
				const message = ack !== null && ack.selected === false ? ack.error : "Selection could not be saved. Retry.";
				setSelectError(message);
				// The Retry affordance below re-issues THIS exact select call, not just dismisses.
				setSelectErrorRetry(() => () => void persistSelection(org, workspace));
				return;
			}
			// An explicit acknowledged selection resets the W-4 loop counter: if the gate still
			// bounces after this, the auto short-circuit gets its full bounded allowance again.
			resetTenancyAutoComplete();
			const bucket = orgCountRef.current <= 1 ? "single" : orgCountRef.current <= 3 ? "few" : "many";
			onboardingClient.sendEvent("tenancy_selected", {
				orgCount: bucket,
				singleOrgConfirm: singleOrgConfirmRef.current ? "true" : "false",
			});
			completeFlow();
		},
		[tenancy, onboardingClient, completeFlow],
	);

	const onCreateWorkspace = React.useCallback(async (): Promise<void> => {
		if (view.kind !== "workspace-list") return;
		const trimmed = createName.trim();
		if (trimmed === "") return;
		setBusy(true);
		setSelectError(null);
		setSelectErrorRetry(null);
		// Bounded by TENANCY_REQUEST_TIMEOUT_MS: this await always settles.
		const ack = await tenancy.createWorkspace(view.org.id, trimmed);
		if (ack === null || ack.created === false) {
			setBusy(false);
			setSelectError(ack !== null && ack.created === false ? ack.error : "Workspace could not be created. Retry.");
			// The Retry affordance below re-issues THIS exact create call.
			setSelectErrorRetry(() => () => void onCreateWorkspace());
			return;
		}
		onboardingClient.sendEvent("workspace_created");
		setBusy(false);
		await persistSelection(view.org, ack.workspace);
	}, [view, createName, tenancy, onboardingClient, persistSelection]);

	const shellStyle: React.CSSProperties = {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 18,
		minHeight: "100vh",
		padding: 28,
		background: "var(--bg-canvas)",
		textAlign: "center",
	};

	if (view.kind === "loading") {
		return (
			<div data-testid="onboarding-tenancy-step" style={shellStyle}>
				<p style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
					Loading your organizations…
				</p>
			</div>
		);
	}

	if (view.kind === "error") {
		return (
			<div data-testid="onboarding-tenancy-step" style={shellStyle}>
				<p data-testid="onboarding-tenancy-error" style={{ fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>
					{view.message}
				</p>
				<Button variant="secondary" data-testid="onboarding-tenancy-retry" onClick={() => view.onRetry()}>
					Retry
				</Button>
				{view.onBack !== undefined && (
					<Button variant="ghost" data-testid="onboarding-tenancy-error-back" onClick={() => view.onBack?.()}>
						Back to organizations
					</Button>
				)}
			</div>
		);
	}

	// W-4: the terminal state past the auto short-circuit bound. No automatic reload happens from
	// here; every further attempt is an explicit operator action.
	if (view.kind === "split-brain") {
		return (
			<div data-testid="onboarding-tenancy-step" style={shellStyle}>
				<div data-testid="onboarding-tenancy-split-brain" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 480 }}>
					<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
						The portal keeps returning you here
					</h1>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
						Your tenancy reads as confirmed in this browser, but the portal cannot verify it and keeps
						redirecting back to this step. The daemon may be unreachable or out of sync. Check that the
						honeycomb daemon is running, then continue.
					</p>
					<Button
						variant="primary"
						size="lg"
						data-testid="onboarding-tenancy-split-brain-continue"
						onClick={() => {
							resetTenancyAutoComplete();
							completeFlow();
						}}
					>
						Go to dashboard
					</Button>
					<Button
						variant="secondary"
						data-testid="onboarding-tenancy-split-brain-retry"
						onClick={() => {
							resetTenancyAutoComplete();
							void loadOrgs();
						}}
					>
						Try again
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div data-testid="onboarding-tenancy-step" style={shellStyle}>
			<div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 520 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Choose where capture writes
				</h1>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Select the organization and workspace your fleet will write to. Nothing captures until you confirm.
				</p>
			</div>

			{view.kind === "org-list" && (
				<div data-testid="onboarding-tenancy-org-list" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 420 }}>
					{view.orgs.map((org) => (
						<Button
							key={org.id}
							variant="secondary"
							size="lg"
							data-testid="onboarding-tenancy-org-option"
							data-org-id={org.id}
							disabled={busy}
							onClick={() => void openWorkspaces(org)}
						>
							{entityLabel(org)}
						</Button>
					))}
				</div>
			)}

			{view.kind === "org-confirm" && (
				<div data-testid="onboarding-tenancy-org-confirm" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }}>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
						Your account has one organization. Confirm you want capture to write under:
					</p>
					<code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--honey)" }}>
						{entityLabel(view.org)} ({view.org.id})
					</code>
					<Button variant="primary" size="lg" data-testid="onboarding-tenancy-org-confirm-btn" disabled={busy} onClick={() => void openWorkspaces(view.org)}>
						Confirm organization
					</Button>
				</div>
			)}

			{view.kind === "workspace-list" && (
				<div data-testid="onboarding-tenancy-workspace-list" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 420 }}>
					<p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0 }}>
						Organization: {entityLabel(view.org)}
					</p>
					{view.workspaces.length === 0 && !view.canCreate ? (
						<>
							<p data-testid="onboarding-tenancy-no-workspaces" style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
								No workspaces are available in this organization.
							</p>
							<Button variant="secondary" data-testid="onboarding-tenancy-back-orgs" disabled={busy} onClick={() => void loadOrgs()}>
								Back to organizations
							</Button>
						</>
					) : (
						<>
							{view.workspaces.map((ws) => (
								<Button
									key={ws.id}
									variant="secondary"
									size="lg"
									data-testid="onboarding-tenancy-workspace-option"
									data-workspace-id={ws.id}
									disabled={busy}
									onClick={() => void persistSelection(view.org, ws)}
								>
									{entityLabel(ws)}
								</Button>
							))}
							{view.canCreate && (
								<div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
									{!showCreate ? (
										<Button variant="ghost" data-testid="onboarding-tenancy-create-toggle" disabled={busy} onClick={() => setShowCreate(true)}>
											Create a new workspace
										</Button>
									) : (
										<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
											<input
												data-testid="onboarding-tenancy-create-input"
												type="text"
												value={createName}
												placeholder="New workspace name"
												disabled={busy}
												onChange={(e) => setCreateName(e.target.value)}
												style={{
													height: 36,
													padding: "0 12px",
													background: "var(--bg-surface)",
													border: "1px solid var(--border-default)",
													borderRadius: "var(--radius-md)",
													color: "var(--text-primary)",
													fontFamily: "var(--font-sans)",
													fontSize: "var(--text-sm)",
												}}
											/>
											<Button variant="primary" data-testid="onboarding-tenancy-create-submit" disabled={busy || createName.trim() === ""} onClick={() => void onCreateWorkspace()}>
												Create and select
											</Button>
										</div>
									)}
								</div>
							)}
							{view.workspaces.length > 0 && orgCountRef.current > 1 && (
								<Button variant="ghost" data-testid="onboarding-tenancy-back-orgs" disabled={busy} onClick={() => void loadOrgs()}>
									Back to organizations
								</Button>
							)}
						</>
					)}
				</div>
			)}

			{selectError !== null && (
				<div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
					<p data-testid="onboarding-tenancy-select-error" style={{ fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>
						{selectError}
					</p>
					<Button
						variant="secondary"
						size="sm"
						data-testid="onboarding-tenancy-select-retry"
						disabled={busy}
						onClick={() => {
							// Re-issue the exact request that failed when one is known (bounded by the
							// client's own timeout, so this can never hang); otherwise just clear the
							// message so the picker is usable again.
							if (selectErrorRetry !== null) selectErrorRetry();
							else setSelectError(null);
						}}
					>
						Retry
					</Button>
				</div>
			)}
		</div>
	);
}
