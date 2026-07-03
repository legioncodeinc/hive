/**
 * The first-run HERO, PRD-009b ob-AC-4/ob-AC-5. A staggered entrance anchored by the Hive mark:
 * the product logos rise and fade in one by one on a spring-like curve, the Hive mark settles
 * center LAST, then the two choice buttons fade in. Pure CSS animation/transition (no new
 * dependency); `prefers-reduced-motion` collapses every entrance to a plain opacity fade with no
 * transform (see the `hc-onboarding-anim` rule below: the SAFE default IS the reduced-motion form,
 * and a `(prefers-reduced-motion: no-preference)` media query is what OPTS IN to the richer motion,
 * so an environment that cannot evaluate the media query at all still gets the safe fade).
 */

import React from "react";

import type { OnboardingProduct } from "./contracts.js";
import { productLogoUrl } from "./product-copy.js";

/** The hero's hardcoded hero mark, in the order they animate in BEFORE the Hive mark settles last. */
const HERO_PRODUCT_MARKS: readonly OnboardingProduct[] = ["honeycomb", "doctor", "nectar"];

/** ob-AC-5, the exact two choices, verbatim copy. */
export type OnboardingMode = "standard" | "advanced";

export interface OnboardingHeroProps {
	readonly assetBase: string;
	readonly onChooseStandard: () => void;
	readonly onChooseAdvanced: () => void;
	/** The per-entry stagger delay (ms) between each product logo. Overridable for tests. */
	readonly staggerMs?: number;
}

/** One staggered hero entry (a product logo, or the Hive mark itself). */
function HeroEntry({
	src,
	delayMs,
	size,
	isAnchor,
	testId,
}: {
	readonly src: string;
	readonly delayMs: number;
	readonly size: number;
	/** The Hive mark settling last gets its own spring-like timing curve (see the CSS below). */
	readonly isAnchor: boolean;
	readonly testId: string;
}): React.JSX.Element {
	return (
		<span
			data-testid={testId}
			className={`hc-onboarding-anim${isAnchor ? " hc-onboarding-hero-anchor" : " hc-onboarding-hero-logo"}`}
			style={{ display: "inline-flex", animationDelay: `${delayMs}ms` }}
		>
			<img src={src} width={size} height={size} alt="" />
		</span>
	);
}

/**
 * The first-run hero + the two-choice entry point. Renders unconditionally once the caller has
 * already decided this IS a first-run (no detection re-derivation happens here, per ob-AC-2).
 */
export function OnboardingHero({ assetBase, onChooseStandard, onChooseAdvanced, staggerMs = 140 }: OnboardingHeroProps): React.JSX.Element {
	return (
		<div
			data-testid="onboarding-hero"
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
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 36, width: "100%", maxWidth: 620 }}>
				<div data-testid="onboarding-hero-marks" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 20 }}>
					{HERO_PRODUCT_MARKS.map((product, i) => (
						<HeroEntry
							key={product}
							testId={`onboarding-hero-logo-${product}`}
							src={productLogoUrl(product, assetBase)}
							delayMs={i * staggerMs}
							size={44}
							isAnchor={false}
						/>
					))}
					{/* The Hive mark settles center LAST: its delay is one full stagger step past the others. */}
					<HeroEntry
						testId="onboarding-hero-mark"
						src={productLogoUrl("hive", assetBase)}
						delayMs={HERO_PRODUCT_MARKS.length * staggerMs}
						size={56}
						isAnchor
					/>
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					<h1 style={{ fontSize: "var(--text-3xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
						Welcome to the hive
					</h1>
					<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-base)", color: "var(--text-secondary)", margin: 0 }}>
						Let&rsquo;s get the rest of your fleet running.
					</p>
				</div>

				<div
					data-testid="onboarding-choices"
					className="hc-onboarding-anim"
					style={{
						animationDelay: `${(HERO_PRODUCT_MARKS.length + 1) * staggerMs}ms`,
						display: "flex",
						gap: 16,
						flexWrap: "wrap",
						justifyContent: "center",
					}}
				>
					<button type="button" data-testid="onboarding-standard-button" onClick={onChooseStandard} style={choiceButtonStyle("primary")}>
						<span style={{ fontWeight: 700 }}>Standard User</span>
						<span style={choiceSubtextStyle("primary")}>Install the fleet (recommended)</span>
					</button>
					<button type="button" data-testid="onboarding-advanced-button" onClick={onChooseAdvanced} style={choiceButtonStyle("secondary")}>
						<span style={{ fontWeight: 700 }}>Advanced User</span>
						<span style={choiceSubtextStyle("secondary")}>Custom installation</span>
					</button>
				</div>
			</div>

			<style>
				{[
					// SAFE default: a plain opacity fade, no transform, this IS the reduced-motion form.
					".hc-onboarding-anim { opacity: 0; animation: hc-onboarding-fade var(--dur-slow) var(--ease-out) both; }",
					"@keyframes hc-onboarding-fade { from { opacity: 0 } to { opacity: 1 } }",
					// Motion allowed: swap in the richer rise-and-settle keyframes, staggered by the
					// inline `animationDelay` each entry already carries.
					"@media (prefers-reduced-motion: no-preference) {",
					"  .hc-onboarding-hero-logo { animation-name: hc-onboarding-rise; animation-duration: 620ms; }",
					// The Hive mark settling last gets a spring-like overshoot curve, distinct from the
					// plain ease-out the product logos use, so it visually "settles" rather than just arriving.
					"  .hc-onboarding-hero-anchor { animation-name: hc-onboarding-settle; animation-duration: 760ms; animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }",
					"}",
					"@keyframes hc-onboarding-rise { from { opacity: 0; transform: translateY(18px) scale(0.9); } to { opacity: 1; transform: translateY(0) scale(1); } }",
					"@keyframes hc-onboarding-settle { from { opacity: 0; transform: translateY(24px) scale(0.7); } to { opacity: 1; transform: translateY(0) scale(1); } }",
				].join("\n")}
			</style>
		</div>
	);
}

function choiceButtonStyle(variant: "primary" | "secondary"): React.CSSProperties {
	return {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: 4,
		minWidth: 220,
		padding: "16px 22px",
		borderRadius: "var(--radius-lg)",
		border: variant === "primary" ? "1px solid transparent" : "1px solid var(--border-strong)",
		background: variant === "primary" ? "var(--honey)" : "var(--bg-elevated)",
		color: variant === "primary" ? "var(--honey-on)" : "var(--text-primary)",
		cursor: "pointer",
		fontFamily: "var(--font-sans)",
		fontSize: "var(--text-base)",
		textAlign: "left",
	};
}

function choiceSubtextStyle(variant: "primary" | "secondary"): React.CSSProperties {
	return {
		fontSize: "var(--text-xs)",
		fontWeight: 500,
		color: variant === "primary" ? "var(--honey-on)" : "var(--text-secondary)",
		opacity: variant === "primary" ? 0.85 : 1,
	};
}
