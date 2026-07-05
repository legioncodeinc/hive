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
 * sequence. Once `/setup/state.authenticated` flips true the parent advances to the PRD-011 tenancy
 * step; the terminal `dashboard_reached` handoff runs only after tenancy selection (ts-AC-1/9).
 *
 * Copy + visual rework: an operator reported the prior screen surfaced the device code with no
 * context, no sense of what Deeplake is or why it is worth linking, and no honest pricing
 * expectation. Everything below the module doc is presentation only, explaining what Deeplake is,
 * what linking unlocks, and that it is a paid service that is cheap to try. The device-flow wiring
 * above (auto-begin, poll, restart, the `onAuthenticated` handoff) is untouched.
 */

import React from "react";

import { Badge, Button } from "../primitives.js";
import { createWireClient, FRESH_SETUP_STATE, type SetupLoginWire, type SetupStateWire, type WireClient } from "../wire.js";
import type { OnboardingClient } from "./onboarding-client.js";

/** Mirrors `setup-gate.tsx`'s `SETUP_POLL_MS`, the live-transition poll cadence. */
export const LOGIN_STEP_POLL_MS = 2500 as const;

export interface LoginStepProps {
	readonly onboardingClient: OnboardingClient;
	/** The proxied setup wire client (defaults to the live one; a test injects a mock). */
	readonly wire?: WireClient;
	/** Test seam: called when login authenticates (parent advances to the tenancy step). */
	readonly onAuthenticated?: () => void;
	/** Overrides {@link LOGIN_STEP_POLL_MS} (a test injects a short window). */
	readonly pollMs?: number;
}

/** A small mono, uppercase eyebrow label, matching {@link Kpi}'s label treatment in `primitives.tsx`. */
function SectionLabel({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
	return (
		<span
			style={{
				fontFamily: "var(--font-mono)",
				fontSize: "var(--text-xs)",
				textTransform: "uppercase",
				letterSpacing: "0.08em",
				color: "var(--text-tertiary)",
			}}
		>
			{children}
		</span>
	);
}

/** What linking a Deeplake account unlocks, kept to short, skimmable lines rather than prose. */
const VALUE_ITEMS: readonly string[] = [
	"Shared memory across every coding assistant you use, not just this one",
	"Semantic recall: find past work by meaning, not only keywords",
	"A new tool or machine already knows your project the moment it connects",
	"Right after this: your dashboard opens and the fleet goes green",
];

function ValueList(): React.JSX.Element {
	return (
		<ul style={{ display: "flex", flexDirection: "column", gap: 8, margin: 0, padding: 0, listStyle: "none", width: "100%" }}>
			{VALUE_ITEMS.map((item) => (
				<li key={item} style={{ display: "flex", gap: 10, alignItems: "flex-start", textAlign: "left" }}>
					<span style={{ flex: "none", marginTop: 7, width: 6, height: 6, borderRadius: "50%", background: "var(--honey)" }} />
					<span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.45 }}>{item}</span>
				</li>
			))}
		</ul>
	);
}

/**
 * The honest pricing expectation the reporting operator asked for: Deeplake is a paid service,
 * but cheap to start, framed as an invitation rather than a paywall. Deliberately no plan names
 * or per-unit prices, only the "small amount goes a long way" framing the brief calls for.
 */
function PricingNote(): React.JSX.Element {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 6,
				width: "100%",
				padding: "12px 14px",
				background: "var(--honey-subtle)",
				border: "1px solid var(--honey-border)",
				borderRadius: "var(--radius-md)",
				textAlign: "left",
			}}
		>
			<Badge tone="honey" mono>
				Good to know
			</Badge>
			<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
				Deeplake is not free, but it is inexpensive to start. A small amount, around $10, goes a long way, and it is worth trying.
			</p>
		</div>
	);
}

/**
 * The "linking your account, data flowing into your hive" motif: a comb cell (the same hexagon
 * clip-path `MemoryCard` in `primitives.tsx` uses) that pulses gently, with small honey drops
 * animating down into it. CSS-only, no new assets, so it stays alive on the page while the
 * operator finishes the browser step.
 */
function LinkingVisual(): React.JSX.Element {
	return (
		<div aria-hidden="true" style={{ position: "relative", width: 84, height: 92, flex: "none" }}>
			<div
				style={{
					position: "absolute",
					left: "50%",
					top: 18,
					transform: "translateX(-50%)",
					width: 56,
					height: 64,
					clipPath: "polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)",
					background: "linear-gradient(180deg, var(--honey-hover), var(--honey))",
					boxShadow: "var(--glow-honey)",
					animation: "onboarding-login-cell-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate",
				}}
			/>
			{[27, 39, 51].map((left, i) => (
				<span
					key={left}
					style={{
						position: "absolute",
						left,
						top: 0,
						width: 6,
						height: 6,
						borderRadius: "50%",
						background: "var(--honey)",
						boxShadow: "0 0 6px var(--honey)",
						animation: "onboarding-login-drop 2.1s var(--ease-in-out) infinite",
						animationDelay: `${i * 0.5}s`,
					}}
				/>
			))}
			<style>{`
				@keyframes onboarding-login-cell-pulse {
					from { opacity: .75; transform: translateX(-50%) scale(0.94); }
					to { opacity: 1; transform: translateX(-50%) scale(1); }
				}
				@keyframes onboarding-login-drop {
					0% { transform: translateY(-4px) scale(0.5); opacity: 0; }
					25% { opacity: 1; transform: translateY(10px) scale(1); }
					70% { opacity: 1; transform: translateY(46px) scale(0.9); }
					100% { transform: translateY(52px) scale(0.3); opacity: 0; }
				}
			`}</style>
		</div>
	);
}

/** The animated "still waiting" indicator: the same words as before, now with a live blinking dot trio. */
function WaitingIndicator(): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
			<span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>Waiting for you to finish in the browser</span>
			<span aria-hidden="true" style={{ display: "inline-flex", gap: 3 }}>
				{[0, 1, 2].map((i) => (
					<span
						key={i}
						style={{
							width: 4,
							height: 4,
							borderRadius: "50%",
							background: "var(--honey)",
							animation: "onboarding-login-blink 1.2s var(--ease-in-out) infinite",
							animationDelay: `${i * 0.2}s`,
						}}
					/>
				))}
			</span>
			<style>{`@keyframes onboarding-login-blink { 0%, 80%, 100% { opacity: .25; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }`}</style>
		</div>
	);
}

/**
 * The grant display (ob-AC-14): the `user_code` prominently, plus `verification_uri_complete`
 * falling back to `verification_uri`, byte-identical fallback rule to `GuidedSetup`'s. Carries a
 * restart affordance: a non-technical operator who closed the verification tab (or let the code
 * expire) gets a one-click fresh code instead of a dead end.
 */
function LoginGrant({ grant, onRestart }: { readonly grant: SetupLoginWire; readonly onRestart: () => void }): React.JSX.Element {
	return (
		<div
			data-testid="onboarding-login-grant"
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 12,
				alignItems: "center",
				width: "100%",
				padding: "20px 22px",
				background: "var(--bg-elevated)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
			}}
		>
			<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
				Enter this code to finish linking your Deeplake account:
			</p>
			<code
				data-testid="onboarding-login-code"
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: "var(--text-2xl)",
					fontWeight: 700,
					color: "var(--honey)",
					letterSpacing: "0.08em",
				}}
			>
				{grant.user_code}
			</code>
			<a
				href={grant.verification_uri_complete ?? grant.verification_uri}
				target="_blank"
				rel="noreferrer"
				data-testid="onboarding-login-verification-link"
				style={{ fontSize: "var(--text-sm)", color: "var(--honey)", fontWeight: 600 }}
			>
				Open the verification page →
			</a>
			<WaitingIndicator />
			<Button variant="secondary" size="sm" onClick={onRestart} data-testid="onboarding-login-restart">
				Closed the window? Restart login
			</Button>
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
	const authenticatedHandledRef = React.useRef(false);

	// One shared "mint a grant" routine: the on-mount auto-begin and the user-facing restart both
	// go through here, so a closed verification tab / expired code / failed first attempt is always
	// recoverable with one click (never a dead end for a non-technical operator).
	const beginLogin = React.useCallback(async (): Promise<void> => {
		setError(false);
		const result = await wire.setupLogin();
		if (result === null) {
			setError(true);
			return;
		}
		setGrant(result);
	}, [wire]);

	const restartLogin = React.useCallback((): void => {
		setGrant(null);
		void beginLogin();
	}, [beginLogin]);

	// Auto-begin the device flow on mount (see module doc for why onboarding skips the button
	// `GuidedSetup` shows on the standalone `/login` route).
	React.useEffect(() => {
		if (beginRef.current) return;
		beginRef.current = true;
		void beginLogin();
	}, [beginLogin]);

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

	// ts-AC-1: authenticated advances to the tenancy step; terminal handoff lives in TenancyStep.
	React.useEffect(() => {
		if (!state.authenticated || authenticatedHandledRef.current) return;
		authenticatedHandledRef.current = true;
		if (onAuthenticated !== undefined) {
			onAuthenticated();
			return;
		}
		// Real usage: parent OnboardingScreen owns the phase transition; this branch is unreachable.
	}, [state.authenticated, onAuthenticated]);

	if (state.authenticated) return <></>;

	return (
		<div
			data-testid="onboarding-login-step"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 20,
				minHeight: "100vh",
				padding: 28,
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<LinkingVisual />

			<div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					One more step: link Deeplake
				</h1>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Your fleet is installed and ready. Linking turns on the memory that follows you everywhere.
				</p>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 480, textAlign: "left" }}>
				<SectionLabel>What is Deeplake?</SectionLabel>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Deeplake, built by Activeloop, is the cloud backend that stores your fleet's shared AI memory and
					code identity. Skip linking it and your fleet still runs, just degraded and local to this machine.
					Link it and capture and recall light up across every coding assistant you use.
				</p>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 480 }}>
				<SectionLabel>What linking unlocks</SectionLabel>
				<ValueList />
			</div>

			<div style={{ maxWidth: 480, width: "100%" }}>
				<PricingNote />
			</div>

			{grant !== null ? (
				<div style={{ maxWidth: 480, width: "100%" }}>
					<LoginGrant grant={grant} onRestart={restartLogin} />
				</div>
			) : error ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
					<p data-testid="onboarding-login-error" style={{ fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>
						Could not start the login.
					</p>
					<Button variant="primary" size="md" onClick={restartLogin} data-testid="onboarding-login-retry">
						Retry login
					</Button>
				</div>
			) : (
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>Starting login…</p>
			)}
		</div>
	);
}
