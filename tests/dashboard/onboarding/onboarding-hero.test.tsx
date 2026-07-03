// @vitest-environment jsdom
/**
 * PRD-009b, the first-run hero (ob-AC-4: staggered animated entrance + reduced-motion fallback,
 * ob-AC-5: exactly two verbatim choices).
 */

import { cleanup, render, screen } from "@testing-library/react";

import { OnboardingHero } from "../../../src/dashboard/web/onboarding/onboarding-hero.js";

afterEach(() => {
	cleanup();
});

describe("OnboardingHero", () => {
	it("ob-AC-4: animates each product logo plus the Hive mark, staggered and NOT statically laid out", () => {
		render(<OnboardingHero assetBase="assets" onChooseStandard={() => {}} onChooseAdvanced={() => {}} />);

		const honeycomb = screen.getByTestId("onboarding-hero-logo-honeycomb");
		const doctor = screen.getByTestId("onboarding-hero-logo-doctor");
		const nectar = screen.getByTestId("onboarding-hero-logo-nectar");
		const hiveMark = screen.getByTestId("onboarding-hero-mark");

		// Every entrant carries the animation class (never a bare static logo row).
		for (const el of [honeycomb, doctor, nectar, hiveMark]) {
			expect(el.className).toContain("hc-onboarding-anim");
		}
		// The Hive mark is a distinct "anchor" entry, styled differently from the product logos, and
		// its delay is one full stagger step past every product logo (settles center LAST).
		expect(hiveMark.className).toContain("hc-onboarding-hero-anchor");
		const delays = [honeycomb, doctor, nectar, hiveMark].map((el) => Number.parseInt(el.style.animationDelay, 10));
		expect(delays[3]).toBeGreaterThan(Math.max(delays[0], delays[1], delays[2]));
		// Ascending stagger order across the three product logos.
		expect(delays[0]).toBeLessThan(delays[1]);
		expect(delays[1]).toBeLessThan(delays[2]);
	});

	it("ob-AC-4: the reduced-motion fallback collapses the entrance to a simple fade (no transform)", () => {
		const { container } = render(<OnboardingHero assetBase="assets" onChooseStandard={() => {}} onChooseAdvanced={() => {}} />);

		const styleTag = container.querySelector("style");
		expect(styleTag).not.toBeNull();
		const css = styleTag?.textContent ?? "";

		// The SAFE (reduced-motion) default is a plain opacity fade with no transform property.
		expect(css).toMatch(/\.hc-onboarding-anim\s*\{[^}]*opacity:\s*0[^}]*\}/);
		expect(css).not.toMatch(/\.hc-onboarding-anim\s*\{[^}]*transform[^}]*\}/);
		// The richer rise/settle motion is gated behind an explicit no-preference media query, so an
		// environment honoring `prefers-reduced-motion: reduce` never receives it.
		expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
		expect(css).toContain("hc-onboarding-rise");
		expect(css).toContain("hc-onboarding-settle");
	});

	it("ob-AC-5: renders exactly two choices with the verbatim required copy", () => {
		render(<OnboardingHero assetBase="assets" onChooseStandard={() => {}} onChooseAdvanced={() => {}} />);

		const buttons = screen.getByTestId("onboarding-choices").querySelectorAll("button");
		expect(buttons).toHaveLength(2);

		const standard = screen.getByTestId("onboarding-standard-button");
		expect(standard.textContent).toContain("Standard User");
		expect(standard.textContent).toContain("Install the fleet (recommended)");

		const advanced = screen.getByTestId("onboarding-advanced-button");
		expect(advanced.textContent).toContain("Advanced User");
		expect(advanced.textContent).toContain("Custom installation");
	});
});
