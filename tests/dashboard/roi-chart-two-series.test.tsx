// @vitest-environment jsdom
/**
 * ISS-010/ISS-011 trend readiness — the RoiTrendChart renders the REAL two-series
 * `/api/diagnostics/roi/trend` payload the newer daemon now serves: series labeled
 * `measured-savings` (solid, verified green) and `modeled-savings` (dashed, amber),
 * per the chart's `seriesColor` heuristics. Also exercises the real data-shape edges:
 * zero-filled days (all-zero cents) and a single-day series — both must render without
 * NaN coordinates or a crash.
 */

import { cleanup, render, screen } from "@testing-library/react";

import type { RoiTrendView } from "../../src/dashboard/contracts.js";
import { RoiTrendChart, seriesCentsRange, seriesPolylinePoints } from "../../src/dashboard/web/pages/roi-chart.js";

/** The exact two-series payload shape the daemon's real `/api/diagnostics/roi/trend` serves. */
const TWO_SERIES_TREND: RoiTrendView = {
	status: "ok",
	startedAt: "2026-06-12",
	series: [
		{
			label: "measured-savings",
			modeled: false,
			points: [
				{ period: "2026-07-06", cents: 0 },
				{ period: "2026-07-07", cents: 120 },
				{ period: "2026-07-08", cents: 0 },
				{ period: "2026-07-09", cents: 340 },
				{ period: "2026-07-10", cents: 280 },
			],
		},
		{
			label: "modeled-savings",
			modeled: true,
			points: [
				{ period: "2026-07-06", cents: 50 },
				{ period: "2026-07-07", cents: 210 },
				{ period: "2026-07-08", cents: 0 },
				{ period: "2026-07-09", cents: 500 },
				{ period: "2026-07-10", cents: 430 },
			],
		},
	],
};

afterEach(() => {
	cleanup();
});

describe("RoiTrendChart two-series render (measured-savings / modeled-savings)", () => {
	it("renders one polyline per series with the correct solid/dashed + color language", () => {
		render(<RoiTrendChart trend={TWO_SERIES_TREND} />);
		expect(screen.getByTestId("roi-trend-chart")).toBeTruthy();

		const measured = screen.getByTestId("roi-trend-series-measured-savings");
		expect(measured.getAttribute("data-modeled")).toBe("false");
		// seriesColor: a non-modeled savings series is the defensible verified green, solid stroke.
		expect(measured.getAttribute("stroke")).toBe("var(--verified)");
		expect(measured.getAttribute("stroke-dasharray")).toBeNull();

		const modeled = screen.getByTestId("roi-trend-series-modeled-savings");
		expect(modeled.getAttribute("data-modeled")).toBe("true");
		// seriesColor: the modeled estimate rides the amber warning tone, dashed stroke (e-AC-3).
		expect(modeled.getAttribute("stroke")).toBe("var(--severity-warning)");
		expect(modeled.getAttribute("stroke-dasharray")).toBe("5 4");
	});

	it("produces finite polyline coordinates for the payload (no NaN in either series)", () => {
		render(<RoiTrendChart trend={TWO_SERIES_TREND} />);
		for (const id of ["roi-trend-series-measured-savings", "roi-trend-series-modeled-savings"]) {
			const points = screen.getByTestId(id).getAttribute("points") ?? "";
			expect(points.length).toBeGreaterThan(0);
			expect(points).not.toContain("NaN");
		}
	});

	it("renders the legend entries with the est. marker on the modeled series only", () => {
		render(<RoiTrendChart trend={TWO_SERIES_TREND} />);
		expect(screen.getByText("measured-savings")).toBeTruthy();
		expect(screen.getByText("modeled-savings (est.)")).toBeTruthy();
	});

	it("renders zero-filled days (all-zero series) without a divide-by-zero or NaN", () => {
		const zeroTrend: RoiTrendView = {
			status: "ok",
			startedAt: "2026-06-12",
			series: [
				{
					label: "measured-savings",
					modeled: false,
					points: [
						{ period: "2026-07-08", cents: 0 },
						{ period: "2026-07-09", cents: 0 },
						{ period: "2026-07-10", cents: 0 },
					],
				},
				{ label: "modeled-savings", modeled: true, points: [{ period: "2026-07-08", cents: 0 }, { period: "2026-07-09", cents: 0 }, { period: "2026-07-10", cents: 0 }] },
			],
		};
		render(<RoiTrendChart trend={zeroTrend} />);
		const points = screen.getByTestId("roi-trend-series-measured-savings").getAttribute("points") ?? "";
		expect(points).not.toContain("NaN");
		// The degenerate all-zero range widens so the divide is safe (max > min).
		const range = seriesCentsRange(zeroTrend.series);
		expect(range.max).toBeGreaterThan(range.min);
	});

	it("renders a single-day series (one point per series) at the left edge, no crash", () => {
		const oneDay: RoiTrendView = {
			status: "ok",
			startedAt: "2026-07-10",
			series: [
				{ label: "measured-savings", modeled: false, points: [{ period: "2026-07-10", cents: 340 }] },
				{ label: "modeled-savings", modeled: true, points: [{ period: "2026-07-10", cents: 500 }] },
			],
		};
		render(<RoiTrendChart trend={oneDay} />);
		const points = screen.getByTestId("roi-trend-series-measured-savings").getAttribute("points") ?? "";
		expect(points).not.toContain("NaN");
		// A single point sits at the left pad edge (stepX = 0) — one coordinate pair, x = PAD.left.
		expect(points.split(" ")).toHaveLength(1);
		expect(points.startsWith("12.0,")).toBe(true);
		// The pure mapper agrees (a one-point series never spreads or divides by zero).
		const mapped = seriesPolylinePoints(oneDay.series[0]!, seriesCentsRange(oneDay.series));
		expect(mapped).toBe(points);
	});
});
