/**
 * The `/login` route's GUIDED-SETUP content — PRD-050b (b-AC-3 / b-AC-6) · PRD-003b (l-AC-1
 * through l-AC-8, relocating this view from a pre-mount React gate to its own path).
 *
 * `/login` is served by hive's server ONLY when the portal gate (`gate.ts`, PRD-003a) has
 * already determined the operator is NOT logged in (or the operator landed here directly — `/login`
 * is gate-exempt, l-AC-3). So this module no longer decides "pre-auth vs authenticated" itself —
 * that decision is the server's. {@link LoginScreen} renders ONE of:
 *
 *   - the plain first-time {@link GuidedSetup} screen — a clear "let's connect your account" panel
 *     fronted by the **"First time setup"** button (b-AC-6). The button BEGINS the on-page device
 *     flow (`POST /setup/login`, proxied per l-AC-1/l-AC-2) and shows the returned `user_code` +
 *     the verification link; the daemon keeps polling → mint → persist in the background.
 *   - {@link MigrationInterrupted} / {@link CoexistenceWarning} when `/setup/state` reports one of
 *     those states (unchanged from the prior pre-auth gate; only the addressing moved).
 *
 * ── The live transition is a POLL, then a hard navigation (l-AC-7 / l-AC-8) ──
 * While on `/login` this screen polls `setupState()` on an interval, exactly like the retired
 * pre-mount gate did. The instant the login flow writes the shared credential, the next poll
 * reports `authenticated: true`; instead of swapping to a client-rendered `<Shell>` (the old
 * behavior), this screen does a HARD navigation (`window.location.assign("/")`) so hive's
 * server gate re-validates health+auth and serves the authoritative next screen. This keeps the
 * gate — not this component — as the single source of truth for "where does an authenticated
 * operator land" (ADR-0004), and correctly falls back to `/buzzing` instead of the dashboard if
 * the fleet happens to be unhealthy at that exact moment.
 *
 * ── b-AC-6: the button is PRESENT in fresh-install, ABSENT once linked ───────
 * The "First time setup" button renders ONLY in the pre-auth branch. Once `authenticated` flips
 * true the whole {@link GuidedSetup} subtree (button included) unmounts as this screen navigates
 * away — so the button is structurally absent in the linked state, not merely hidden.
 *
 * ── No token, no secret, no portal session (l-AC-5) ──────────────────────────
 * This screen reads only `/setup/state` (install metadata) and `/setup/login` (user_code + URIs).
 * NO token crosses either wire (the schemas have no token field by construction), and it creates,
 * stores, or reads no portal-specific cookie or session — credential presence via `/setup/state` is
 * the sole source of truth (ADR-0004's rejection of a portal session).
 */

import React from "react";

import { Button } from "./primitives.js";
import {
	createWireClient,
	FRESH_SETUP_STATE,
	type SetupStateWire,
	type SetupLoginWire,
	type SetupMigrateWire,
	type WireClient,
} from "./wire.js";

/** How often the pre-auth screen polls `/setup/state` for the live transition (ms). */
export const SETUP_POLL_MS = 2500 as const;

/** The migration sub-phases that mean "interrupted, not terminal" (d-AC-7 resume/rollback trigger). */
const NON_TERMINAL_MIGRATION_PHASES = new Set(["backup", "uninstall", "link"]);

/**
 * True when the setup state shows an INTERRUPTED migration (a non-terminal `migration.phase`) — the
 * dashboard must then present the resume/rollback affordance, NEVER a clean state (d-AC-7).
 */
export function isMigrationInterrupted(state: SetupStateWire): boolean {
	return state.migration !== undefined && NON_TERMINAL_MIGRATION_PHASES.has(state.migration.phase);
}

/**
 * True when the setup state shows a PRIOR Hivemind install that has NOT yet been migrated (d-AC-1) — the
 * dashboard renders the coexistence-warning wizard rather than the plain first-time state. Keys off the
 * derived `priorTool.hivemind === "present"` (or the raw `~/.hivemind` dir presence), and is suppressed
 * once `priorTool.hivemind === "migrated"`.
 */
export function hasUnmigratedPriorHivemind(state: SetupStateWire): boolean {
	if (state.priorTool.hivemind === "migrated") return false;
	return state.priorTool.hivemind === "present" || state.credentials.hivemind;
}

/** Props for {@link LoginScreen} — the injected wire client + the asset base. */
export interface LoginScreenProps {
	/** The wire client (injected by a unit test with a mocked fetch; defaults to the live one). */
	readonly client?: WireClient;
	/** The base path the host serves the logo/assets under. */
	readonly assetBase?: string;
}

/**
 * The guided-setup PRE-AUTH screen (b-AC-6). A single centered panel: the brand mark, a short
 * "connect your account" line, and the "First time setup" button that begins the on-page login. Once
 * the login grant arrives the panel shows the `user_code` + the verification link (the daemon polls →
 * persists in the background; the parent {@link LoginScreen} polls `/setup/state` and hard-navigates
 * to the dashboard when the credential lands). The migration variant (a detected prior Hivemind) is 050d.
 */
export function GuidedSetup({
	wire,
	assetBase,
	state,
}: {
	wire: WireClient;
	assetBase: string;
	state: SetupStateWire;
}): React.JSX.Element {
	const [grant, setGrant] = React.useState<SetupLoginWire | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState(false);

	// A synchronous in-flight guard so a rapid double-click never fires two device flows.
	const inFlightRef = React.useRef(false);

	const beginSetup = React.useCallback(async (): Promise<void> => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setBusy(true);
		setError(false);
		const result = await wire.setupLogin();
		if (result === null) {
			// The device flow could not begin (502 / network). Show an honest error; the user can
			// retry the button or fall back to the `honeycomb login` CLI.
			setError(true);
			setBusy(false);
			inFlightRef.current = false;
			return;
		}
		setGrant(result);
		// Leave `busy` true: the page now waits for the background poll (in LoginScreen) to flip to the
		// authenticated dashboard once the credential lands. The button stays disabled meanwhile.
	}, [wire]);

	// Restart the login from the grant state: a non-technical operator who closed the verification
	// tab (or let the code expire) needs a one-click way to mint a FRESH code — never a dead end.
	// Resets the in-flight guard so beginSetup fires a new device flow; the daemon's pending-link
	// slot replaces the stale flow.
	const restartSetup = React.useCallback((): void => {
		inFlightRef.current = false;
		setBusy(false);
		setGrant(null);
		void beginSetup();
	}, [beginSetup]);

	// A prior Hivemind install is a HINT for the copy (050d owns the migration path); 050b only
	// surfaces it as a sub-line so the fresh-install vs has-prior-tool states read differently.
	const hasPriorHivemind = state.priorTool.hivemind === "present" || state.credentials.hivemind;

	return (
		<div
			data-testid="guided-setup"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 18,
				minHeight: "100vh",
				padding: "28px",
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<img src={`${assetBase}/honeycomb-memory-cluster.svg`} width={56} height={56} alt="" />
			<div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 460 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Let&rsquo;s connect your account
				</h1>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					{hasPriorHivemind
						? "We found a previous Hivemind setup. Link your account to bring your memory online."
						: "Honeycomb keeps one shared memory for all your coding agents. Link your account to get started."}
				</p>
			</div>

			{grant === null ? (
				<>
					{/* b-AC-6: the "First time setup" button — present ONLY in the pre-auth (fresh-install) state. */}
					<Button variant="primary" size="lg" onClick={() => void beginSetup()} disabled={busy}>
						{busy ? "Starting setup…" : "First time setup"}
					</Button>
					{error && (
						<p data-testid="setup-error" style={{ fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>
							Could not start setup. Click the button above to try again.
						</p>
					)}
				</>
			) : (
				// The grant arrived: show the user_code + the verification link. The daemon polls →
				// persists in the background; LoginScreen's poll hard-navigates to the dashboard when it lands.
				<div data-testid="setup-grant" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
						Enter this code to finish linking:
					</p>
					<code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-lg)", color: "var(--honey)", letterSpacing: "0.08em" }}>
						{grant.user_code}
					</code>
					<a
						href={grant.verification_uri_complete ?? grant.verification_uri}
						target="_blank"
						rel="noreferrer"
						style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}
					>
						Open the verification page
					</a>
					<span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>Waiting for you to finish in the browser…</span>
					<Button variant="secondary" size="sm" onClick={restartSetup} data-testid="setup-restart-login">
						Closed the window? Restart login
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * The COEXISTENCE-WARNING wizard — PRD-050d (d-AC-1 / d-AC-2 / d-AC-3 / d-AC-4). Renders instead of the
 * plain first-time {@link GuidedSetup} when a prior, un-migrated Hivemind install is detected. It states
 * — BEFORE any destructive action — that running Hivemind and Honeycomb together is UNSUPPORTED and what
 * "Proceed with Honeycomb" does (back up + uninstall Hivemind, then reuse the shared login), then gates
 * the migrate call behind an explicit CONFIRM step (d-AC-2).
 *
 * On "Proceed" it POSTs `migrateFromHivemind`: a `migrated` result lets the parent's `/setup/state` poll
 * flip to the dashboard (no re-auth — the shared credential was adopted, d-AC-4); a `needsLogin` result
 * hands off to the on-page device flow ({@link GuidedSetup}'s login button, the 050c `--ref mario` flow);
 * an `ok:false` partial failure shows the plain-language message + the backup path (d-AC-5), never a stack.
 */
export function CoexistenceWarning({
	wire,
	assetBase,
	onNeedsLogin,
}: {
	wire: WireClient;
	assetBase: string;
	/** Called when the migration completed the uninstall but needs the device flow to finish linking (d-AC-4). */
	onNeedsLogin: () => void;
}): React.JSX.Element {
	const [confirming, setConfirming] = React.useState(false);
	const [busy, setBusy] = React.useState(false);
	const [result, setResult] = React.useState<SetupMigrateWire | null>(null);
	const inFlightRef = React.useRef(false);

	const proceed = React.useCallback(async (): Promise<void> => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setBusy(true);
		const r = await wire.migrateFromHivemind();
		setResult(r);
		if (r.ok && r.needsLogin === true) {
			// Uninstall done; the shared credential was not adoptable → run the 050c device flow.
			onNeedsLogin();
			return;
		}
		// `migrated` success: leave `busy` true — the parent LoginScreen poll hard-navigates once
		// `/setup/state.authenticated` lands. A partial failure (`ok:false`) re-enables retry below.
		if (!r.ok) {
			setBusy(false);
			inFlightRef.current = false;
		}
	}, [wire, onNeedsLogin]);

	return (
		<div
			data-testid="coexistence-warning"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 18,
				minHeight: "100vh",
				padding: "28px",
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<img src={`${assetBase}/honeycomb-memory-cluster.svg`} width={56} height={56} alt="" />
			<div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 500 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					We found an existing Hivemind setup
				</h1>
				{/* d-AC-2: the rule + what Proceed does, stated clearly BEFORE any destructive action. */}
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Running Hivemind and Honeycomb on the same machine isn&rsquo;t supported &mdash; they share one
					memory and would collide. <strong>Proceed with Honeycomb</strong> will back up your Hivemind config,
					uninstall Hivemind, and reuse your existing DeepLake login (so you likely won&rsquo;t even need to
					sign in again).
				</p>
			</div>

			{result !== null && result.ok === false ? (
				// d-AC-5: a partial/failed uninstall — plain-language message + the backup location, retryable.
				<div data-testid="migration-error" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center", maxWidth: 500 }}>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>{result.message}</p>
					{result.backupPath !== undefined && (
						<p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0 }}>
							Backup saved at <code style={{ fontFamily: "var(--font-mono)" }}>{result.backupPath}</code>
						</p>
					)}
					<Button variant="primary" size="lg" onClick={() => void proceed()} disabled={busy}>
						{busy ? "Retrying…" : "Retry"}
					</Button>
				</div>
			) : !confirming ? (
				// First step: the explicit gate. The destructive migrate fires only after this confirm (d-AC-2).
				<Button variant="primary" size="lg" onClick={() => setConfirming(true)} data-testid="proceed-button">
					Proceed with Honeycomb
				</Button>
			) : (
				// Confirm step: a last explicit acknowledgement before the back-up + uninstall runs.
				<div data-testid="migration-confirm" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
						This backs up and removes your Hivemind setup. Continue?
					</p>
					<div style={{ display: "flex", gap: 10 }}>
						<Button variant="secondary" size="md" onClick={() => setConfirming(false)} disabled={busy}>
							Cancel
						</Button>
						<Button variant="danger" size="md" onClick={() => void proceed()} disabled={busy} data-testid="confirm-migrate-button">
							{busy ? "Migrating…" : "Yes, proceed"}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * The INTERRUPTED-MIGRATION surface — PRD-050d (d-AC-7). Rendered when `/setup/state` reports a
 * NON-TERMINAL `migration.phase` (a daemon crash mid-migration). It NEVER presents the machine as cleanly
 * migrated or cleanly reverted: it states the migration was interrupted and offers RESUME (re-run the
 * idempotent migration) or ROLL BACK (restore the Hivemind backup). The backup path is shown for trust.
 */
export function MigrationInterrupted({
	wire,
	assetBase,
	state,
	onNeedsLogin,
}: {
	wire: WireClient;
	assetBase: string;
	state: SetupStateWire;
	onNeedsLogin: () => void;
}): React.JSX.Element {
	const [busy, setBusy] = React.useState<"" | "resume" | "rollback">("");
	const [message, setMessage] = React.useState<string | null>(null);
	const phase = state.migration?.phase ?? "backup";
	const backupPath = state.migration?.backupPath;

	const resume = React.useCallback(async (): Promise<void> => {
		setBusy("resume");
		const r = await wire.migrateFromHivemind();
		setMessage(r.message);
		if (r.ok && r.needsLogin === true) {
			onNeedsLogin();
			return;
		}
		// On success the parent poll flips to the dashboard; on failure leave the message + re-enable.
		if (!r.ok) setBusy("");
	}, [wire, onNeedsLogin]);

	const rollback = React.useCallback(async (): Promise<void> => {
		setBusy("rollback");
		const r = await wire.rollbackMigration();
		setMessage(r.message);
		// After a rollback the parent poll re-reads `/setup/state` (now `rolled_back`, terminal) and the
		// coexistence-warning re-renders from a clean restored state; re-enable the buttons regardless.
		setBusy("");
	}, [wire]);

	return (
		<div
			data-testid="migration-interrupted"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 18,
				minHeight: "100vh",
				padding: "28px",
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<img src={`${assetBase}/honeycomb-memory-cluster.svg`} width={56} height={56} alt="" />
			<div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 500 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Your migration was interrupted
				</h1>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					A previous switch to Honeycomb didn&rsquo;t finish (it stopped at the <code>{phase}</code> step). You
					can resume it, or roll back to restore your previous Hivemind setup.
				</p>
				{backupPath !== undefined && (
					<p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0 }}>
						Backup at <code style={{ fontFamily: "var(--font-mono)" }}>{backupPath}</code>
					</p>
				)}
			</div>
			<div style={{ display: "flex", gap: 10 }}>
				<Button variant="primary" size="md" onClick={() => void resume()} disabled={busy !== ""} data-testid="resume-button">
					{busy === "resume" ? "Resuming…" : "Resume"}
				</Button>
				<Button variant="secondary" size="md" onClick={() => void rollback()} disabled={busy !== ""} data-testid="rollback-button">
					{busy === "rollback" ? "Rolling back…" : "Roll back"}
				</Button>
			</div>
			{message !== null && (
				<p data-testid="migration-interrupted-message" style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
					{message}
				</p>
			)}
		</div>
	);
}

/**
 * The `/login` route's top-level content (b-AC-3 / b-AC-6 / d-AC-1 / d-AC-7 / l-AC-1 / l-AC-7 /
 * l-AC-8). Polls `/setup/state` and renders ONE of:
 *   - the {@link MigrationInterrupted} resume/rollback surface when a migration is mid-flight (d-AC-7);
 *   - the {@link CoexistenceWarning} wizard when a prior un-migrated Hivemind is detected (d-AC-1);
 *   - the plain first-time {@link GuidedSetup} otherwise (l-AC-1).
 * Once `/setup/state.authenticated` flips true, this screen does a HARD navigation to `/` instead
 * of rendering the dashboard itself (l-AC-7 / l-AC-8) — see the module doc for why that stays the
 * server gate's decision, not this component's.
 *
 * The FIRST render shows the guided-setup state (the fresh-install-safe default) until the first
 * poll resolves, so a slow first read never flashes a stale state.
 */
export function LoginScreen({ client, assetBase = "assets" }: LoginScreenProps = {}): React.JSX.Element {
	const wire = React.useMemo<WireClient>(() => client ?? createWireClient(), [client]);
	const [state, setState] = React.useState<SetupStateWire>(FRESH_SETUP_STATE);
	// Once the migration's uninstall completes but needs the device flow (d-AC-4), force the login UI
	// (GuidedSetup) even though a prior-Hivemind dir may still be reported — the user must finish linking.
	const [forceLogin, setForceLogin] = React.useState(false);
	// A synchronous guard so the navigation below fires exactly once even if this effect re-runs
	// (e.g. React 18 StrictMode's double-invoke in development) before the browser actually leaves.
	const navigatedRef = React.useRef(false);

	React.useEffect(() => {
		if (state.authenticated) {
			// l-AC-7 / l-AC-8: auth flipped true. A HARD navigation (not a client-side component swap)
			// so hive's server gate (gate.ts) re-validates health+auth for the new request and serves
			// the authoritative next screen — `/` (the dashboard) if the fleet is still healthy, or
			// `/buzzing` in the (rare) case it degraded in the interim. This is deliberately NOT a
			// `usePathRoute().navigate` client-side swap: there is no mounted Shell here to swap into,
			// and re-deriving "go to the dashboard" here would duplicate the gate's own decision.
			if (!navigatedRef.current && typeof window !== "undefined") {
				navigatedRef.current = true;
				window.location.assign("/");
			}
			return;
		}
		let alive = true;
		const tick = async (): Promise<void> => {
			const next = await wire.setupState();
			if (alive) setState(next);
		};
		void tick();
		// Keep polling while pre-auth so the transition is live; cleared on unmount and on the
		// authenticated flip (the effect re-runs and early-returns above).
		const id = setInterval(() => void tick(), SETUP_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [wire, state.authenticated]);

	// AUTHENTICATED: the navigation above is in flight. Render nothing further — the browser is
	// about to leave this screen for the real dashboard request.
	if (state.authenticated) {
		return <></>;
	}
	// d-AC-7: an interrupted migration ALWAYS wins — a half-migrated machine is never presented as a
	// clean first-time/coexistence state. Resume/rollback until the marker reaches a terminal phase.
	if (isMigrationInterrupted(state) && !forceLogin) {
		return <MigrationInterrupted wire={wire} assetBase={assetBase} state={state} onNeedsLogin={() => setForceLogin(true)} />;
	}
	// d-AC-1: a prior un-migrated Hivemind renders the coexistence-warning wizard (not the plain
	// first-time state) — unless the migration already handed off to the login flow (`forceLogin`).
	if (hasUnmigratedPriorHivemind(state) && !forceLogin) {
		return <CoexistenceWarning wire={wire} assetBase={assetBase} onNeedsLogin={() => setForceLogin(true)} />;
	}
	return <GuidedSetup wire={wire} assetBase={assetBase} state={state} />;
}
