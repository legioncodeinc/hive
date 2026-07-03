// @vitest-environment jsdom
/**
 * PRD-009b ob-AC-7, the Advanced picker: product cards with checkboxes, a `Recommended` badge on
 * Doctor, a visible warning when Doctor is deselected, and confirming enters the guided flow for
 * exactly the chosen products.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AdvancedPicker } from "../../../src/dashboard/web/onboarding/advanced-picker.js";

afterEach(() => {
	cleanup();
});

describe("AdvancedPicker", () => {
	it("ob-AC-7: lists every remaining product as a checked-by-default card, Doctor carrying Recommended", () => {
		render(<AdvancedPicker products={["doctor", "honeycomb", "nectar"]} assetBase="assets" onConfirm={() => {}} />);

		expect(screen.getByTestId("onboarding-picker-item-doctor")).toBeTruthy();
		expect(screen.getByTestId("onboarding-picker-item-honeycomb")).toBeTruthy();
		expect(screen.getByTestId("onboarding-picker-item-nectar")).toBeTruthy();

		for (const product of ["doctor", "honeycomb", "nectar"]) {
			expect((screen.getByTestId(`onboarding-picker-checkbox-${product}`) as HTMLInputElement).checked).toBe(true);
		}
		expect(screen.getByTestId("onboarding-picker-item-doctor").textContent).toContain("Recommended");
		expect(screen.getByTestId("onboarding-picker-item-honeycomb").textContent).not.toContain("Recommended");
	});

	it("ob-AC-7: only lists the REMAINING (not-yet-installed) products, never the full fixed set", () => {
		render(<AdvancedPicker products={["nectar"]} assetBase="assets" onConfirm={() => {}} />);

		expect(screen.queryByTestId("onboarding-picker-item-doctor")).toBeNull();
		expect(screen.queryByTestId("onboarding-picker-item-honeycomb")).toBeNull();
		expect(screen.getByTestId("onboarding-picker-item-nectar")).toBeTruthy();
	});

	it("ob-AC-7: deselecting Doctor shows the visible warning; reselecting hides it", () => {
		render(<AdvancedPicker products={["doctor", "honeycomb", "nectar"]} assetBase="assets" onConfirm={() => {}} />);

		expect(screen.queryByTestId("onboarding-picker-doctor-warning")).toBeNull();

		fireEvent.click(screen.getByTestId("onboarding-picker-checkbox-doctor"));
		expect(screen.getByTestId("onboarding-picker-doctor-warning").textContent).toMatch(/restarts your daemons/i);

		fireEvent.click(screen.getByTestId("onboarding-picker-checkbox-doctor"));
		expect(screen.queryByTestId("onboarding-picker-doctor-warning")).toBeNull();
	});

	it("ob-AC-7: confirming hands back EXACTLY the chosen subset, in the fixed order", () => {
		const onConfirm = vi.fn();
		render(<AdvancedPicker products={["doctor", "honeycomb", "nectar"]} assetBase="assets" onConfirm={onConfirm} />);

		fireEvent.click(screen.getByTestId("onboarding-picker-checkbox-honeycomb"));
		fireEvent.click(screen.getByTestId("onboarding-picker-confirm"));

		expect(onConfirm).toHaveBeenCalledWith(["doctor", "nectar"]);
	});
});
