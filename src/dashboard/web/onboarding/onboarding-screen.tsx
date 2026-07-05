/**
 * The `/onboarding` route's TOP-LEVEL screen, PRD-009b. Mirrors `/buzzing`/`/login`'s posture
 * (`buzzing-screen.tsx`, `setup-gate.tsx`): a single top-level component `main.tsx` mounts directly
 * (via `boot-route.ts`), owning its own state machine rather than nesting inside the authenticated
 * `<Shell>`. The state machine:
 *
 *   detect (+ an upfront health read for ob-AC-3) ─┬─ all installed AND healthy → short-circuit
 *                                                   ├─ a remaining product is mid-flight/failed →
 *                                                   │    resume straight into "installing" (ob-AC-16/17)
 *                                                   └─ otherwise → the first-run hero (ob-AC-4/5)
 *   hero ─ Standard → installing(all remaining, fixed order)         (ob-AC-6)
 *        └ Advanced → picker → installing(exactly the chosen subset)  (ob-AC-7)
 *   installing(queue, index) ── each card completes+dwells → advance → next index, else → health
 *   health ── polls until ready → login
 *   login ── device-code display → tenancy when authenticated (PRD-011a)
 *   tenancy ── org + workspace selection → hard navigation to `/` on `selected: true` (ts-AC-9)
 *
 * Resume honesty (ob-AC-16): the Standard/Advanced choice is persisted client-side
 * (onboarding-selection-store), so a resumed install uses `buildResumeQueue`, which excludes a
 * not-installed product the operator explicitly deselected in Advanced. Without that memory, resume
 * would fall back to only products that are genuinely mid-flight or failed, never silently
 * reinstalling a deselected one.
 */

import React from "react";

import { AdvancedPicker } from "./advanced-picker.js";
import {
	buildResumeQueue,
	DEFAULT_PRODUCT_DETECTION,
	detectionFor,
	hasResumableInstall,
	isFleetFullyInstalled,
	remainingProducts,
	type DetectResponse,
	type InstallableProduct,
} from "./contracts.js";
import { clearSelection, persistSelection, readSelection } from "./onboarding-selection-store.js";
import { HealthView } from "./health-view.js";
import { InstallCard } from "./install-card.js";
import { LoginStep } from "./login-step.js";
import { createOnboardingClient, type OnboardingClient } from "./onboarding-client.js";
import { OnboardingHero, type OnboardingMode } from "./onboarding-hero.js";
import type { TenancyClient } from "./tenancy-client.js";
import { consumeTenancyAutoComplete, TenancyStep } from "./tenancy-step.js";
import { useOnboardingToken } from "./use-onboarding-token.js";
import { Button } from "../primitives.js";
import { createWireClient, type WireClient } from "../wire.js";

type Phase =
	| { readonly kind: "loading" }
	| { readonly kind: "short-circuit" }
	| { readonly kind: "hero" }
	| { readonly kind: "picker" }
	| { readonly kind: "installing"; readonly queue: readonly InstallableProduct[]; readonly index: number }
	| { readonly kind: "health" }
	| { readonly kind: "login" }
	| { readonly kind: "tenancy" };

/** An empty install queue means nothing more to do, skip straight to the health gate. */
function installingOrHealth(queue: readonly InstallableProduct[]): Phase {
	return queue.length === 0 ? { kind: "health" } : { kind: "installing", queue, index: 0 };
}

export interface OnboardingScreenProps {
	readonly assetBase?: string;
	/** Test seam: inject a fake onboarding client, bypassing the real token + fetch wiring entirely. */
	readonly client?: OnboardingClient;
	/** Test seam: inject a fake proxied setup wire client for the login step. */
	readonly wire?: WireClient;
	/** Test seam: inject a fake tenancy client for the tenancy step (never touches the network). */
	readonly tenancyClient?: TenancyClient;
	/** Test seam: override the brief install dwell (ob-AC-11, revised). */
	readonly minDwellMs?: number;
	/** Test seam: override the health-check poll interval. */
	readonly healthPollMs?: number;
	/** Test seam: override the login step's `/setup/state` poll interval. */
	readonly loginPollMs?: number;
	/** Test seam: called instead of the real hard navigation from the short-circuit summary. */
	readonly onShortCircuitNavigate?: () => void;
	/** Test seam: called instead of the real hard navigation once tenancy selection completes. */
	readonly onAuthenticated?: () => void;
}

/** ob-AC-3, the terminal "nothing to do" screen for an already-installed, healthy machine. */
function ShortCircuitSummary({ onGoToDashboard }: { readonly onGoToDashboard: () => void }): React.JSX.Element {
	return (
		<div
			data-testid="onboarding-short-circuit"
			style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 32, background: "var(--bg-canvas)", textAlign: "center" }}
		>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 18,
					maxWidth: 440,
					padding: "40px 32px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-xl)",
				}}
			>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Your fleet is already up
				</h1>
				<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Every product is installed and the fleet reads healthy. Nothing to install here.
				</p>
				<Button variant="primary" size="lg" data-testid="onboarding-go-to-dashboard" onClick={onGoToDashboard}>
					Go to dashboard
				</Button>
			</div>
		</div>
	);
}

/**
 * The terminal "no token" screen for a machine that is genuinely NOT installed/authenticated. The
 * one-time token rides the opened URL (`/onboarding?t=...`) and is held in memory only, so landing
 * here without one (a refresh after the URL scrub, the printed fallback link, a bookmark) cannot
 * recover the INSTALLER flow on its own: the operator re-runs the installer, which mints a fresh
 * token and reopens the portal. PRD-011c C-1: an installed + authenticated + tenancy-unselected
 * machine never lands here; the tokenless probe below resumes it at the tenancy step instead,
 * because the tenancy step's whole data plane is the token-free `/setup/*` surface (ts-AC-12).
 */
function MissingTokenNotice(): React.JSX.Element {
	return (
		<div
			data-testid="onboarding-missing-token"
			style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 32, background: "var(--bg-canvas)", textAlign: "center" }}
		>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 18,
					maxWidth: 480,
					padding: "40px 32px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-xl)",
				}}
			>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					This setup link has expired
				</h1>
				<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					The setup page needs the one-time link the installer opens for you, and this visit did not carry
					it (refreshing this page drops it too). Re-run the installer to get a fresh link:
				</p>
				<code
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: "var(--text-xs)",
						color: "var(--text-primary)",
						background: "var(--bg-canvas)",
						border: "1px solid var(--border-default)",
						borderRadius: "var(--radius-md)",
						padding: "10px 14px",
					}}
				>
					curl -fsSL https://get.theapiary.sh | sh
				</code>
			</div>
		</div>
	);
}

/** The brief pre-detection placeholder, visible only for the moment detect+health are in flight. */
function LoadingPlaceholder(): React.JSX.Element {
	return (
		<div
			data-testid="onboarding-loading"
			style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "var(--bg-canvas)" }}
		>
			<p style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>Checking what is already installed…</p>
		</div>
	);
}

export function OnboardingScreen({
	assetBase = "assets",
	client: clientOverride,
	wire,
	tenancyClient,
	minDwellMs,
	healthPollMs,
	loginPollMs,
	onShortCircuitNavigate,
	onAuthenticated,
}: OnboardingScreenProps): React.JSX.Element {
	const token = useOnboardingToken();
	// A test-injected client bypasses the token gate entirely (it never talks to the real token
	// wiring); real usage waits for `useOnboardingToken` to resolve the `?t=` query param first.
	// A RESOLVED-ABSENT token (`""`) is terminal: without it every installer call 401s, so the
	// screen shows recovery guidance below instead of spinning on the loading placeholder forever.
	const tokenReady = clientOverride !== undefined || (token !== null && token !== "");
	const tokenMissing = clientOverride === undefined && token === "";
	const client = React.useMemo<OnboardingClient>(() => clientOverride ?? createOnboardingClient(token ?? ""), [clientOverride, token]);

	const wireClient = React.useMemo<WireClient>(() => wire ?? createWireClient(), [wire]);

	const [phase, setPhase] = React.useState<Phase>({ kind: "loading" });
	const [detection, setDetection] = React.useState<DetectResponse | null>(null);

	const startedEventFiredRef = React.useRef(false);
	React.useEffect(() => {
		if (!tokenReady || startedEventFiredRef.current) return;
		startedEventFiredRef.current = true;
		client.sendEvent("onboarding_started");
	}, [client, tokenReady]);

	React.useEffect(() => {
		if (!tokenReady) return;
		let alive = true;
		void (async (): Promise<void> => {
			const [detectResult, healthResult] = await Promise.all([client.detect(), client.health()]);
			if (!alive) return;
			setDetection(detectResult);
			if (isFleetFullyInstalled(detectResult) && healthResult.ready) {
				const setupState = await wireClient.setupState();
				if (setupState.authenticated) {
					const tenancy = await wireClient.setupTenancy();
					if (!tenancy.selected) {
						setPhase({ kind: "tenancy" });
						return;
					}
				}
				setPhase({ kind: "short-circuit" });
			} else if (hasResumableInstall(detectResult)) {
				// Resume honors the operator's persisted subset so a deselected product is never
				// silently reinstalled; falls back to only mid-flight/failed products when unknown.
				setPhase(installingOrHealth(buildResumeQueue(detectResult, readSelection())));
			} else {
				setPhase({ kind: "hero" });
			}
		})();
		return () => {
			alive = false;
		};
	}, [client, tokenReady, wireClient]);

	const chooseMode = React.useCallback(
		(mode: OnboardingMode): void => {
			client.sendEvent("mode_selected", { mode });
			if (mode === "standard") {
				const queue = detection !== null ? remainingProducts(detection) : [];
				persistSelection(queue);
				setPhase(installingOrHealth(queue));
			} else {
				setPhase({ kind: "picker" });
			}
		},
		[client, detection],
	);

	const confirmAdvanced = React.useCallback((selected: readonly InstallableProduct[]): void => {
		persistSelection(selected);
		setPhase(installingOrHealth(selected));
	}, []);

	const advanceInstall = React.useCallback((): void => {
		setPhase((current) => {
			if (current.kind !== "installing") return current;
			const nextIndex = current.index + 1;
			return nextIndex >= current.queue.length ? { kind: "health" } : { kind: "installing", queue: current.queue, index: nextIndex };
		});
	}, []);

	const goToLogin = React.useCallback((): void => setPhase({ kind: "login" }), []);

	const handleShortCircuitNavigate = React.useCallback((): void => {
		clearSelection();
		if (onShortCircuitNavigate !== undefined) {
			onShortCircuitNavigate();
			return;
		}
		if (typeof window !== "undefined") window.location.assign("/");
	}, [onShortCircuitNavigate]);

	// ts-AC-9: terminal handoff after tenancy selection persists; drop the persisted install subset.
	const handleTenancyComplete = React.useCallback((): void => {
		clearSelection();
		if (onAuthenticated !== undefined) {
			onAuthenticated();
			return;
		}
		if (typeof window !== "undefined") window.location.assign("/");
	}, [onAuthenticated]);

	// ts-AC-1: login authenticates into the tenancy phase, not the dashboard.
	const handleLoginAuthenticated = React.useCallback((): void => {
		setPhase({ kind: "tenancy" });
	}, []);

	// PRD-011c C-1 (tg-AC-8 / ts-AC-10): the gate's tenancy redirect navigates to `/onboarding`
	// WITHOUT a `?t=` token, so a tokenless mount must not dead-end on the expired-link notice
	// when the machine is actually installed, authenticated, and merely tenancy-unselected. The
	// tenancy step's entire data plane is the token-free `/setup/*` surface (ts-AC-12), so probe
	// `/setup/state` + `/setup/tenancy` (both token-free by design) and resume there directly:
	//   - authenticated + unselected  -> the tenancy phase (the gated redirect's intended landing)
	//   - authenticated + selected    -> straight back to `/` (nothing to resume; the gate serves it)
	//   - not authenticated           -> the genuine expired-link notice (installer must re-run)
	// An unreachable/failed probe reads as not-authenticated (fail-soft into the honest notice).
	const [tokenlessResume, setTokenlessResume] = React.useState<"probing" | "tenancy" | "expired">("probing");
	React.useEffect(() => {
		if (!tokenMissing) return;
		let alive = true;
		void (async (): Promise<void> => {
			const [setupState, tenancy] = await Promise.all([wireClient.setupState(), wireClient.setupTenancy()]);
			if (!alive) return;
			if (!setupState.authenticated) {
				setTokenlessResume("expired");
				return;
			}
			if (tenancy.selected) {
				// Tenancy is already confirmed (e.g. a stale bookmark): hand back to the
				// gate-served dashboard without firing any funnel event. This auto-navigation is
				// bounded by the same W-4 lap counter as the tenancy step's short-circuit: in the
				// split-brain fault (browser reads selected, the gate's read persistently fails)
				// the gate bounces every navigation back here, so past the allowance the flow
				// falls through to the tenancy step, whose terminal split-brain state stops the
				// loop with manual affordances.
				if (consumeTenancyAutoComplete()) {
					handleTenancyComplete();
					return;
				}
			}
			setTokenlessResume("tenancy");
		})().catch(() => {
			// N-2: fail closed on a THROWN probe (not just a resolved failure). The wire client
			// already never throws by contract, but the terminal-notice fallback must not depend
			// on that guarantee: any unexpected throw reads as not-authenticated.
			if (alive) setTokenlessResume("expired");
		});
		return () => {
			alive = false;
		};
	}, [tokenMissing, wireClient, handleTenancyComplete]);

	if (tokenMissing) {
		if (tokenlessResume === "probing") return <LoadingPlaceholder />;
		if (tokenlessResume === "tenancy") {
			return <TenancyStep onboardingClient={client} tenancyClient={tenancyClient} onComplete={handleTenancyComplete} />;
		}
		return <MissingTokenNotice />;
	}

	switch (phase.kind) {
		case "loading":
			return <LoadingPlaceholder />;
		case "short-circuit":
			return <ShortCircuitSummary onGoToDashboard={handleShortCircuitNavigate} />;
		case "hero":
			return <OnboardingHero assetBase={assetBase} onChooseStandard={() => chooseMode("standard")} onChooseAdvanced={() => chooseMode("advanced")} />;
		case "picker":
			return <AdvancedPicker products={detection !== null ? remainingProducts(detection) : []} assetBase={assetBase} onConfirm={confirmAdvanced} />;
		case "installing": {
			const product = phase.queue[phase.index];
			const initialDetection = detection !== null ? detectionFor(detection, product) : DEFAULT_PRODUCT_DETECTION;
			return (
				<InstallCard
					key={product}
					product={product}
					initialDetection={initialDetection}
					client={client}
					assetBase={assetBase}
					onAdvance={advanceInstall}
					minDwellMs={minDwellMs}
				/>
			);
		}
		case "health":
			return <HealthView client={client} onReady={goToLogin} pollMs={healthPollMs} />;
		case "login":
			return <LoginStep onboardingClient={client} wire={wire} onAuthenticated={handleLoginAuthenticated} pollMs={loginPollMs} />;
		case "tenancy":
			return <TenancyStep onboardingClient={client} tenancyClient={tenancyClient} onComplete={handleTenancyComplete} />;
		default: {
			const exhaustive: never = phase;
			return exhaustive;
		}
	}
}
