/**
 * The per-product GUIDED INSTALL CARD, PRD-009b ob-AC-8/ob-AC-9/ob-AC-10/ob-AC-11/ob-AC-12. A
 * full-screen card carrying the product's logo, title, benefit copy, staged (never percent)
 * progress, and the npm-safety reassurance. Honors a brief minimum dwell on success (ob-AC-11,
 * revised: the real install time drives the pace, the dwell only prevents a flash-through) and
 * NEVER masks a failure behind that dwell (ob-AC-12), a `failed` stage renders its truthful error
 * plus a retry affordance the instant it arrives, regardless of elapsed dwell time.
 *
 * Re-entry (ob-AC-16/ob-AC-17): `initialDetection` (the daemon's own truth from `/api/onboarding/
 * detect`) decides the card's opening move, `install_in_progress` RE-ATTACHES the SSE stream
 * without a new install POST; `install_failed` renders the failure immediately and waits for an
 * explicit retry; anything else starts a fresh install.
 */

import React from "react";

import { IN_FLIGHT_STAGES, installRefusalMessage, type InstallableProduct, type InstallStage, type ProductDetection, type ProductInstallError } from "./contracts.js";
import type { OnboardingClient } from "./onboarding-client.js";
import { INSTALL_STAGE_LABEL, NPM_SAFETY_COPY, PRODUCT_COPY, productLogoUrl } from "./product-copy.js";
import { useInstallDwell } from "./use-install-dwell.js";

export interface InstallCardProps {
	readonly product: InstallableProduct;
	/** The daemon's detection truth for THIS product at the moment the card mounted (ob-AC-16). */
	readonly initialDetection: ProductDetection;
	readonly client: OnboardingClient;
	readonly assetBase: string;
	/** Called once this product's install has both completed AND satisfied its minimum dwell. */
	readonly onAdvance: () => void;
	/** Overrides the default brief minimum dwell (ob-AC-11, revised). A test injects a short window. */
	readonly minDwellMs?: number;
}

function stageStepState(stepIndex: number, doneCount: number, terminal: InstallStage): "done" | "active" | "pending" {
	if (stepIndex < doneCount) return "done";
	if (stepIndex === doneCount && terminal !== "completed") return "active";
	return "pending";
}

/** The per-stage stepper (ob-AC-9): a labeled list, never a fabricated percentage. */
function StageStepper({ product, stage }: { readonly product: InstallableProduct; readonly stage: InstallStage }): React.JSX.Element {
	const currentIndex = (IN_FLIGHT_STAGES as readonly string[]).indexOf(stage);
	const doneCount = stage === "completed" ? IN_FLIGHT_STAGES.length : Math.max(0, currentIndex);

	return (
		<ul
			data-testid={`onboarding-install-stage-${product}`}
			data-current-stage={stage}
			style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8, width: "100%", textAlign: "left" }}
		>
			{IN_FLIGHT_STAGES.map((step, i) => {
				const state = stageStepState(i, doneCount, stage);
				return (
					<li
						key={step}
						data-state={state}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 10,
							fontFamily: "var(--font-sans)",
							fontSize: "var(--text-sm)",
							color: state === "pending" ? "var(--text-tertiary)" : "var(--text-primary)",
						}}
					>
						<span
							aria-hidden="true"
							style={{
								width: 8,
								height: 8,
								flex: "none",
								borderRadius: "50%",
								background: state === "done" ? "var(--verified)" : state === "active" ? "var(--honey)" : "var(--border-strong)",
								animation: state === "active" ? "hc-onboarding-stage-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate" : "none",
							}}
						/>
						{INSTALL_STAGE_LABEL[step]}
					</li>
				);
			})}
		</ul>
	);
}

/** ob-AC-10, the npm-safety reassurance, verbatim, on every card. */
function NpmSafetyNote({ product }: { readonly product: InstallableProduct }): React.JSX.Element {
	return (
		<p
			data-testid={`onboarding-npm-safety-${product}`}
			style={{
				fontFamily: "var(--font-sans)",
				fontSize: "var(--text-xs)",
				color: "var(--text-tertiary)",
				margin: 0,
				lineHeight: 1.5,
				padding: "10px 14px",
				background: "var(--bg-inset)",
				border: "1px solid var(--border-subtle)",
				borderRadius: "var(--radius-md)",
			}}
		>
			{NPM_SAFETY_COPY}
		</p>
	);
}

export function InstallCard({ product, initialDetection, client, assetBase, onAdvance, minDwellMs }: InstallCardProps): React.JSX.Element {
	// Captured ONCE at mount, later prop identity changes (a parent re-render passing an
	// equivalent-but-new object) must never re-trigger the opening-move decision below.
	const openingRef = React.useRef(initialDetection);
	const wasInitiallyInstalled = openingRef.current.state === "installed";
	const wasInitiallyFailed = openingRef.current.state === "install_failed";

	const [stage, setStage] = React.useState<InstallStage>(() => {
		if (wasInitiallyInstalled) return "completed";
		if (wasInitiallyFailed) return "failed";
		return "resolving";
	});
	const [error, setError] = React.useState<ProductInstallError | null>(() => openingRef.current.error ?? null);
	// Bumped by the retry button; also doubles as "has the operator asked us to try again" so a
	// card that OPENED failed runs no network activity until this leaves 0 (ob-AC-12).
	const [attempt, setAttempt] = React.useState(0);

	React.useEffect(() => {
		if (wasInitiallyInstalled) return;
		if (wasInitiallyFailed && attempt === 0) return;

		let cancelled = false;
		let unsubscribe: () => void = () => {};

		void (async (): Promise<void> => {
			// ob-AC-17: re-attach ONLY on the very first attempt of a card that opened mid-flight ,
			// every retry (attempt > 0) always re-POSTs a fresh install, even for that same product.
			const reattachOnly = attempt === 0 && openingRef.current.state === "install_in_progress";

			if (!reattachOnly) {
				const started = await client.startInstall(product);
				if (cancelled) return;
				if (started === null) {
					setError({ stage: "resolving", summary: "Could not reach the daemon to start the install. Check your connection and retry." });
					setStage("failed");
					return;
				}
				if ("error" in started) {
					setError({ stage: "resolving", summary: installRefusalMessage(started.error) });
					setStage("failed");
					return;
				}
				if (started.state === "installed") {
					// A race the daemon itself resolved before this card's POST landed, still honors
					// the minimum dwell below, just skips the SSE stream entirely (nothing to stream).
					setStage("completed");
					return;
				}
			}

			setError(null);
			unsubscribe = client.subscribeInstallEvents(product, (event) => {
				if (cancelled) return;
				setStage(event.stage);
				if (event.stage === "failed") {
					setError({ stage: "unknown", summary: event.detail ?? "The install failed. Retry below, or check the daemon logs." });
				}
			});
		})();

		return () => {
			cancelled = true;
			unsubscribe();
		};
		// `product`/`client` are stable for a card's lifetime; `attempt` is the sole re-run trigger.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [attempt, wasInitiallyFailed, wasInitiallyInstalled]);

	const handleRetry = React.useCallback((): void => {
		setError(null);
		setStage("resolving");
		setAttempt((n) => n + 1);
	}, []);

	// ob-AC-11: gates ONLY the success-advance path. A `failed` stage is rendered above regardless
	// of dwell, this hook never sees `ready:true` for a failed card, so it can never mask one.
	useInstallDwell(stage === "completed", { onDwellSatisfied: onAdvance, minDwellMs });

	const copy = PRODUCT_COPY[product];
	const failed = stage === "failed";

	return (
		<div
			data-testid={`onboarding-install-card-${product}`}
			data-stage={stage}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				minHeight: "100vh",
				padding: 32,
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 22,
					width: "100%",
					maxWidth: 540,
					padding: "44px 40px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-xl)",
				}}
			>
				<img src={productLogoUrl(product, assetBase)} width={64} height={64} alt="" />
				<h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					{copy.title}
				</h1>

				<div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 440 }}>
					<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-base)", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
						{copy.headline}
					</p>
					<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
						{copy.lines[0]}
					</p>
					<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
						{copy.lines[1]}
					</p>
				</div>

				{failed ? (
					<div
						data-testid={`onboarding-install-error-${product}`}
						style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", width: "100%" }}
					>
						<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>
							{error?.summary ?? "The install failed."}
						</p>
						<button
							type="button"
							data-testid={`onboarding-retry-${product}`}
							onClick={handleRetry}
							style={{
								height: 40,
								padding: "0 18px",
								borderRadius: "var(--radius-md)",
								border: "1px solid var(--severity-critical)",
								background: "var(--severity-critical-bg)",
								color: "var(--severity-critical)",
								fontFamily: "var(--font-sans)",
								fontSize: "var(--text-sm)",
								fontWeight: 600,
								cursor: "pointer",
							}}
						>
							Retry
						</button>
					</div>
				) : (
					<StageStepper product={product} stage={stage} />
				)}

				<NpmSafetyNote product={product} />
			</div>

			<style>{"@keyframes hc-onboarding-stage-pulse { from { opacity: .4 } to { opacity: 1 } }"}</style>
		</div>
	);
}
