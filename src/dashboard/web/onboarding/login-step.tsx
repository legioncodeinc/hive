/**
 * The onboarding LOGIN STEP, PRD-009b ob-AC-14/ob-AC-15. Closes the known device-code display gap
 * by reusing the EXACT wire contract `GuidedSetup` (`src/dashboard/web/setup-gate.tsx`) already
 * defines (`POST /setup/login`, polled `GET /setup/state`) WITHOUT modifying that module: this is
 * the sibling component the task brief calls for, sharing `wire.ts`'s types/client rather than
 * duplicating the device-flow request shapes.
 *
 * Unlike `/login`'s `GuidedSetup` (which waits for an explicit "First time setup" click), the
 * onboarding flow has already walked the operator through installs and a health check, so this
 * step begins the device flow automatically on mount: one fewer click at the end of a long guided
 * sequence. Once `/setup/state.authenticated` flips true it fires `dashboard_reached`, best-effort
 * POSTs `/api/onboarding/complete`, then hard-navigates to `/` (ob-AC-15) so the server gate
 * revalidates and serves the authoritative dashboard, the same discipline `LoginScreen` follows.
 */

import React from "react";

import { createWireClient, FRESH_SETUP_STATE, type SetupLoginWire, type SetupStateWire, type WireClient } from "../wire.js";
import type { OnboardingClient } from "./onboarding-client.js";

/** Mirrors `setup-gate.tsx`'s `SETUP_POLL_MS`, the live-transition poll cadence. */
export const LOGIN_STEP_POLL_MS = 2500 as const;

export interface LoginStepProps {
	readonly onboardingClient: OnboardingClient;
	/** The proxied setup wire client (defaults to the live one; a test injects a mock). */
	readonly wire?: WireClient;
	/** Test seam: called instead of the real hard navigation once authenticated. */
	readonly onAuthenticated?: () => void;
	/** Overrides {@link LOGIN_STEP_POLL_MS} (a test injects a short window). */
	readonly pollMs?: number;
}

/**
 * The grant display (ob-AC-14): the `user_code` prominently, plus `verification_uri_complete`
 * falling back to `verification_uri`, byte-identical fallback rule to `GuidedSetup`'s.
 */
function LoginGrant({ grant }: { readonly grant: SetupLoginWire }): React.JSX.Element {
	return (
		<div data-testid="onboarding-login-grant" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
			<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
				Enter this code to finish linking your Deeplake account:
			</p>
			<code
				data-testid="onboarding-login-code"
				style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-lg)", color: "var(--honey)", letterSpacing: "0.08em" }}
			>
				{grant.user_code}
			</code>
			<a
				href={grant.verification_uri_complete ?? grant.verification_uri}
				target="_blank"
				rel="noreferrer"
				data-testid="onboarding-login-verification-link"
				style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}
			>
				Open the verification page
			</a>
			<span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>Waiting for you to finish in the browser…</span>
		</div>
	);
}

export function LoginStep({ onboardingClient, wire: wireOverride, onAuthenticated, pollMs = LOGIN_STEP_POLL_MS }: LoginStepProps): React.JSX.Element {
	const wire = React.useMemo<WireClient>(() => wireOverride ?? createWireClient(), [wireOverride]);
	const [state, setState] = React.useState<SetupStateWire>(FRESH_SETUP_STATE);
	const [grant, setGrant] = React.useState<SetupLoginWire | null>(null);
	const [error, setError] = React.useState(false);

	const beginRef = React.useRef(false);
	const grantShownEventRef = React.useRef(false);
	const navigatedRef = React.useRef(false);

	// Auto-begin the device flow on mount (see module doc for why onboarding skips the button
	// `GuidedSetup` shows on the standalone `/login` route).
	React.useEffect(() => {
		if (beginRef.current) return;
		beginRef.current = true;
		void (async (): Promise<void> => {
			const result = await wire.setupLogin();
			if (result === null) {
				setError(true);
				return;
			}
			setGrant(result);
		})();
	}, [wire]);

	// ob-AC-14, `login_shown` fires the moment the grant (the code the operator must see) renders.
	React.useEffect(() => {
		if (grant === null || grantShownEventRef.current) return;
		grantShownEventRef.current = true;
		onboardingClient.sendEvent("login_shown");
	}, [grant, onboardingClient]);

	// Poll `/setup/state` for the live authenticated transition, exactly like `LoginScreen` does.
	React.useEffect(() => {
		if (state.authenticated) return;
		let alive = true;
		const tick = async (): Promise<void> => {
			const next = await wire.setupState();
			if (alive) setState(next);
		};
		void tick();
		const id = setInterval(() => void tick(), pollMs);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [wire, state.authenticated, pollMs]);

	// ob-AC-15, authenticated: fire `dashboard_reached`, best-effort POST complete, then hard-nav.
	React.useEffect(() => {
		if (!state.authenticated || navigatedRef.current) return;
		navigatedRef.current = true;
		onboardingClient.sendEvent("dashboard_reached");
		void (async (): Promise<void> => {
			await onboardingClient.complete();
			if (onAuthenticated !== undefined) {
				onAuthenticated();
				return;
			}
			if (typeof window !== "undefined") window.location.assign("/");
		})();
	}, [state.authenticated, onboardingClient, onAuthenticated]);

	if (state.authenticated) return <></>;

	return (
		<div
			data-testid="onboarding-login-step"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 18,
				minHeight: "100vh",
				padding: 28,
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 460 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					One last step: link Deeplake
				</h1>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Your fleet is up. Link your Deeplake account and you are on your dashboard.
				</p>
			</div>

			{grant !== null ? (
				<LoginGrant grant={grant} />
			) : error ? (
				<p data-testid="onboarding-login-error" style={{ fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>
					Could not start the login. Retry, or run <code>honeycomb login</code> in your terminal.
				</p>
			) : (
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>Starting login…</p>
			)}
		</div>
	);
}
