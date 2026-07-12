// @vitest-environment jsdom
/**
 * ISS-007 (display slice): search-result scores are RRF-fused values in the 0.0008–0.05 range, so
 * the former `score.toFixed(2)` render on the MemoryCard always showed "0.00". `formatScore` now
 * renders 3 significant digits with trailing zeros dropped, and the card renders through it.
 */

import { cleanup, render, screen } from "@testing-library/react";

import { formatScore, MemoryCard } from "../../src/dashboard/web/primitives.js";

afterEach(() => {
	cleanup();
});

describe("formatScore (ISS-007: significant digits, never a flattened 0.00)", () => {
	it("renders a typical RRF-fused score at 3 significant digits", () => {
		expect(formatScore(0.016279)).toBe("0.0163");
	});

	it("renders the bottom of the real score range without flattening to 0.00", () => {
		expect(formatScore(0.0008)).toBe("0.0008");
		expect(formatScore(0.05)).toBe("0.05");
	});

	it("drops trailing zeros on round values (compact badge footprint)", () => {
		expect(formatScore(0.5)).toBe("0.5");
		expect(formatScore(1)).toBe("1");
	});

	it("degrades a non-finite score honestly instead of throwing into React", () => {
		expect(formatScore(Number.NaN)).toBe("0");
		expect(formatScore(Number.POSITIVE_INFINITY)).toBe("0");
	});

	it("renders zero as plain 0", () => {
		expect(formatScore(0)).toBe("0");
	});
});

describe("MemoryCard score badge", () => {
	it("renders the RRF score at significant digits, not the flattened '0.00'", () => {
		render(<MemoryCard memoryKey="deploy.release" snippet="we deploy via just release" score={0.016279} />);
		expect(screen.getByText("0.0163")).toBeTruthy();
		expect(screen.queryByText("0.00")).toBeNull();
	});

	it("renders no score badge at all when the score is absent (unchanged behavior)", () => {
		render(<MemoryCard memoryKey="deploy.release" snippet="we deploy via just release" />);
		expect(screen.queryByText("0.00")).toBeNull();
		expect(screen.queryByText("0")).toBeNull();
	});
});
