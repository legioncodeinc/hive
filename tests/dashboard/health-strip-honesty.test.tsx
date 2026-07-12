// @vitest-environment jsdom
/**
 * The dashboard HealthStrip chip render matrix (Wave-3 QA W-1/W-2 + plan item 4's hive half).
 * Asserts each new daemon state renders a DISTINCT, honestly-toned chip:
 *   · portkey `no_model` → warning "no model set" pointing at Settings (the misconfigured gateway
 *     that used to render as a healthy "off" — ISS-005's false-healthy reading);
 *   · portkey `unreachable` + `portkeyUnreachableStatus` → `unreachable(401)`;
 *   · semantic warming/suspect/failed → neutral/warning/critical tones respectively;
 *   · the parse-layer `unknown` fallback renders as literal "unknown", never a healthy chip;
 *   · memoryFormation → a committed-count chip, plus a warning "N extraction errors" chip ONLY when
 *     the error counter is non-zero, with the capped daemon error text as a hover (title) detail.
 * Tones are asserted through the Badge's semantic color vars (verified/neutral/warning/critical).
 */

import { cleanup, render } from "@testing-library/react";

import { HealthStrip } from "../../src/dashboard/web/pages/dashboard.js";
import type { HealthReasonsWire } from "../../src/dashboard/web/wire.js";

/** A fully-healthy baseline reasons block; tests override single fields. */
const HEALTHY: HealthReasonsWire = { storage: "reachable", embeddings: "on", schema: "ok", portkey: "ok" };

/** The Badge tone → its foreground color var (mirrors primitives.tsx `Badge`). */
const TONE_COLOR = {
	verified: "var(--verified)",
	neutral: "var(--text-secondary)",
	warning: "var(--severity-warning)",
	critical: "var(--severity-critical)",
} as const;

/** Find the Badge span whose full text matches — the one carrying the tone's inline color. */
function chip(container: HTMLElement, text: string): HTMLElement {
	const spans = [...container.querySelectorAll("span")].filter(
		(el) => el.textContent === text && el.style.color !== "",
	);
	expect(spans.length, `expected exactly one badge reading "${text}"`).toBe(1);
	return spans[0];
}

afterEach(() => cleanup());

describe("HealthStrip — portkey chip honesty (W-1)", () => {
	it("no_model → a WARNING 'no model set' chip whose hover detail points at Settings", () => {
		const { container } = render(<HealthStrip reasons={{ ...HEALTHY, portkey: "no_model" }} />);
		const el = chip(container, "portkey: no model set");
		expect(el.style.color).toBe(TONE_COLOR.warning);
		expect(el.closest("span[title]")?.getAttribute("title")).toContain("Settings");
	});

	it("unreachable with a captured status → a CRITICAL 'unreachable(401)' chip", () => {
		const { container } = render(
			<HealthStrip reasons={{ ...HEALTHY, portkey: "unreachable", portkeyUnreachableStatus: 401 }} />,
		);
		expect(chip(container, "portkey: unreachable(401)").style.color).toBe(TONE_COLOR.critical);
	});

	it("unreachable without a status → a plain CRITICAL 'unreachable' chip (old daemon)", () => {
		const { container } = render(<HealthStrip reasons={{ ...HEALTHY, portkey: "unreachable" }} />);
		expect(chip(container, "portkey: unreachable").style.color).toBe(TONE_COLOR.critical);
	});

	it("the parse-layer 'unknown' fallback renders literally as neutral 'unknown' — never a healthy chip", () => {
		const { container } = render(<HealthStrip reasons={{ ...HEALTHY, portkey: "unknown" }} />);
		const el = chip(container, "portkey: unknown");
		expect(el.style.color).toBe(TONE_COLOR.neutral);
		expect(el.style.color).not.toBe(TONE_COLOR.verified);
	});

	it("off/ok stay healthy (verified) — legacy behaviour preserved", () => {
		for (const state of ["off", "ok"] as const) {
			const { container, unmount } = render(<HealthStrip reasons={{ ...HEALTHY, portkey: state }} />);
			expect(chip(container, `portkey: ${state}`).style.color).toBe(TONE_COLOR.verified);
			unmount();
		}
	});
});

describe("HealthStrip — semantic (embeddings) chip tones (W-2)", () => {
	it("warming → a NEUTRAL 'warming…' chip (transitional, not broken)", () => {
		const { container } = render(<HealthStrip reasons={{ ...HEALTHY, embeddingsState: "warming" }} />);
		expect(chip(container, "semantic: warming…").style.color).toBe(TONE_COLOR.neutral);
	});

	it("suspect → a WARNING chip (missed liveness probe — the wedge-suspicion window is visible)", () => {
		const { container } = render(<HealthStrip reasons={{ ...HEALTHY, embeddingsState: "suspect" }} />);
		expect(chip(container, "semantic: suspect").style.color).toBe(TONE_COLOR.warning);
	});

	it("failed → a CRITICAL chip", () => {
		const { container } = render(<HealthStrip reasons={{ ...HEALTHY, embeddingsState: "failed" }} />);
		expect(chip(container, "semantic: failed").style.color).toBe(TONE_COLOR.critical);
	});

	it("the coarse field alone drives the tone on a daemon without embeddingsState (suspect via coarse mirror)", () => {
		const { container } = render(<HealthStrip reasons={{ ...HEALTHY, embeddings: "suspect" }} />);
		expect(chip(container, "semantic: suspect").style.color).toBe(TONE_COLOR.warning);
	});

	it("the parse-layer 'unknown' coarse fallback renders as neutral 'unknown' — never a healthy 'on'", () => {
		const { container } = render(<HealthStrip reasons={{ ...HEALTHY, embeddings: "unknown" }} />);
		const el = chip(container, "semantic: unknown");
		expect(el.style.color).toBe(TONE_COLOR.neutral);
		expect(el.style.color).not.toBe(TONE_COLOR.verified);
	});

	it("on → verified (healthy behaviour preserved)", () => {
		const { container } = render(<HealthStrip reasons={HEALTHY} />);
		expect(chip(container, "semantic: on").style.color).toBe(TONE_COLOR.verified);
	});
});

describe("HealthStrip — memoryFormation chips (plan item 4's hive half)", () => {
	it("absent block (old daemon) → NO memory-formation chips (back-compat: nothing new renders)", () => {
		const { queryByTestId } = render(<HealthStrip reasons={HEALTHY} />);
		expect(queryByTestId("memory-formation-chip")).toBeNull();
		expect(queryByTestId("extraction-errors-chip")).toBeNull();
	});

	it("zero extraction errors → the committed-count chip only, NO error chip", () => {
		const { getByTestId, queryByTestId } = render(
			<HealthStrip
				reasons={{ ...HEALTHY, memoryFormation: { committedSinceBoot: 5, extractionErrorsSinceBoot: 0 } }}
			/>,
		);
		expect(getByTestId("memory-formation-chip").textContent).toContain("5 formed");
		expect(queryByTestId("extraction-errors-chip")).toBeNull();
	});

	it("N > 0 extraction errors → a WARNING 'N extraction errors' chip with the daemon error text as hover detail", () => {
		const { container, getByTestId } = render(
			<HealthStrip
				reasons={{
					...HEALTHY,
					memoryFormation: {
						committedSinceBoot: 0,
						extractionErrorsSinceBoot: 373,
						lastExtractionError: "portkey: 401 unauthorized",
						lastExtractionErrorAt: "2026-07-12T00:01:00.000Z",
					},
				}}
			/>,
		);
		const wrap = getByTestId("extraction-errors-chip");
		expect(wrap.textContent).toBe("373 extraction errors");
		expect(wrap.getAttribute("title")).toContain("portkey: 401 unauthorized");
		expect(chip(container, "373 extraction errors").style.color).toBe(TONE_COLOR.warning);
	});

	it("a single error reads '1 extraction error' (no plural)", () => {
		const { getByTestId } = render(
			<HealthStrip
				reasons={{ ...HEALTHY, memoryFormation: { committedSinceBoot: 0, extractionErrorsSinceBoot: 1 } }}
			/>,
		);
		expect(getByTestId("extraction-errors-chip").textContent).toBe("1 extraction error");
	});

	it("caps the displayed lastExtractionError at 200 chars even if a misbehaving daemon sends more", () => {
		const long = "x".repeat(500);
		const { getByTestId } = render(
			<HealthStrip
				reasons={{
					...HEALTHY,
					memoryFormation: { committedSinceBoot: 0, extractionErrorsSinceBoot: 2, lastExtractionError: long },
				}}
			/>,
		);
		expect(getByTestId("extraction-errors-chip").getAttribute("title")).toHaveLength(200);
	});

	it("renders daemon-shaped error text as TEXT — markup in the error string is never interpreted", () => {
		const { getByTestId } = render(
			<HealthStrip
				reasons={{
					...HEALTHY,
					memoryFormation: {
						committedSinceBoot: 0,
						extractionErrorsSinceBoot: 1,
						lastExtractionError: '<img src=x onerror=alert(1)>',
					},
				}}
			/>,
		);
		const wrap = getByTestId("extraction-errors-chip");
		// The payload lands verbatim in the title ATTRIBUTE (escaped by React), never as an element.
		expect(wrap.getAttribute("title")).toBe('<img src=x onerror=alert(1)>');
		expect(wrap.querySelector("img")).toBeNull();
	});
});
