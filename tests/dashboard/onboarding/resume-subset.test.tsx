// @vitest-environment jsdom
import { buildResumeQueue, type DetectResponse } from "../../../src/dashboard/web/onboarding/contracts.js";

// ob-AC-16 resume honesty: a deselected product must never be silently reinstalled on re-entry.

describe("buildResumeQueue (ob-AC-16 resume honors the chosen subset)", () => {
	it("excludes a not-installed product the operator deselected (persisted Advanced subset)", () => {
		// Operator chose Advanced and picked only doctor; nectar was deselected. An interruption
		// leaves doctor failed and nectar simply not_installed. Resume must NOT queue nectar.
		const d: DetectResponse = {
			products: {
				doctor: { state: "install_failed", error: { stage: "downloading", summary: "network" } },
				honeycomb: { state: "installed", version: "0.2.1" },
				nectar: { state: "not_installed" },
			},
		};
		expect(buildResumeQueue(d, ["doctor"])).toEqual(["doctor"]);
	});

	it("keeps every product the operator actually chose that is not yet installed", () => {
		const d: DetectResponse = {
			products: {
				doctor: { state: "installed", version: "0.2.1" },
				honeycomb: { state: "install_in_progress" },
				nectar: { state: "not_installed" },
			},
		};
		expect(buildResumeQueue(d, ["honeycomb", "nectar"])).toEqual(["honeycomb", "nectar"]);
	});

	it("with no persisted selection, resumes only genuinely mid-flight or failed products", () => {
		// Fresh browser / cleared storage: intent is unknown, so a merely not_installed product is
		// left out; only the in-flight fact (nectar failed) is resumed.
		const d: DetectResponse = {
			products: {
				doctor: { state: "not_installed" },
				honeycomb: { state: "not_installed" },
				nectar: { state: "install_failed", error: { stage: "linking", summary: "eacces" } },
			},
		};
		expect(buildResumeQueue(d, null)).toEqual(["nectar"]);
	});

	it("normalizes the resumed queue to the fixed product order", () => {
		const d: DetectResponse = {
			products: {
				doctor: { state: "install_failed", error: { stage: "resolving", summary: "x" } },
				honeycomb: { state: "not_installed" },
				nectar: { state: "install_in_progress" },
			},
		};
		expect(buildResumeQueue(d, ["nectar", "doctor", "honeycomb"])).toEqual(["doctor", "honeycomb", "nectar"]);
	});
});
