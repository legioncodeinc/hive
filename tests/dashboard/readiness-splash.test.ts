/**
 * PRD-002b — pure helpers for the readiness splash.
 *
 * Full render tests (rs-AC-2/3/5/6/7/9) live in `readiness-splash-render.test.tsx`
 * (jsdom environment via a per-file `@vitest-environment` pragma, `@testing-library/react`).
 */

import {
	deriveDaemonDisplayState,
	isReady,
	type DaemonDisplayState,
} from "../../src/dashboard/web/readiness-splash.js";
import { isFleetReady } from "../../src/daemon/fleet-status.js";

describe("deriveDaemonDisplayState", () => {
	const cases: Array<{ health: "ok" | "degraded" | "unreachable" | "unknown"; expected: DaemonDisplayState }> = [
		{ health: "ok", expected: "up" },
		{ health: "degraded", expected: "degraded" },
		{ health: "unreachable", expected: "unreachable" },
		{ health: "unknown", expected: "starting" },
	];

	it.each(cases)("rs-AC-5 maps health $health to display state $expected", ({ health, expected }) => {
		expect(deriveDaemonDisplayState(health)).toBe(expected);
	});
});

describe("isReady re-export", () => {
	it("matches daemon isFleetReady behavior (browser-safe mirror)", () => {
		const ready = {
			supervisor: "reachable" as const,
			health: "ok" as const,
			asOf: "2026-07-01T12:00:00.000Z",
			daemons: [{ name: "honeycomb", health: "ok" as const, escalation: null }],
		};
		expect(isReady(ready)).toBe(true);
		expect(isFleetReady(ready)).toBe(true);

		const notReady = { supervisor: "unreachable" as const, daemons: [] as const };
		expect(isReady(notReady)).toBe(false);
		expect(isFleetReady(notReady)).toBe(false);
	});
});
