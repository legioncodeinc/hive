/**
 * ISS-013 (UI slice): the Pollinate ack used to render a below-threshold decline as "already
 * running" — a lie. `pollinateNoteFromAck` now renders honest copy for the distinct
 * `below-threshold` status (with tokens/threshold progress when present), while a genuine
 * `running` ack keeps "already running". `PollinateAckSchema` parses old-daemon bodies (no
 * tokens/threshold fields) and malformed values defensively via `.optional().catch(undefined)`.
 */

import { pollinateNoteFromAck } from "../../src/dashboard/web/pages/memories.js";
import { PollinateAckSchema } from "../../src/dashboard/web/wire.js";

describe("pollinateNoteFromAck (ISS-013: honest below-threshold copy)", () => {
	it("renders 'not enough new activity yet' with progress when tokens + threshold are present", () => {
		// Locale-formatted via the same toLocaleString the implementation uses (locale-robust in CI).
		expect(pollinateNoteFromAck({ triggered: false, status: "below-threshold", tokens: 1200, threshold: 50000 })).toBe(
			`not enough new activity yet · ${(1200).toLocaleString()}/${(50000).toLocaleString()} tokens`,
		);
	});

	it("renders the honest copy without progress when the fields are absent (older field-less ack)", () => {
		expect(pollinateNoteFromAck({ triggered: false, status: "below-threshold" })).toBe("not enough new activity yet");
	});

	it("recognizes below-threshold via the reason field too (defensive against either wire shape)", () => {
		expect(pollinateNoteFromAck({ triggered: false, status: "skipped", reason: "below-threshold" })).toBe(
			"not enough new activity yet",
		);
	});

	it("never renders 'already running' for a below-threshold ack, even when triggered rides true", () => {
		expect(pollinateNoteFromAck({ triggered: true, status: "below-threshold", tokens: 10, threshold: 100 })).toBe(
			"not enough new activity yet · 10/100 tokens",
		);
	});

	it("keeps 'already running' for a genuine running ack (unchanged behavior)", () => {
		expect(pollinateNoteFromAck({ triggered: true, status: "running" })).toBe("already running");
	});

	it("keeps 'consolidating…' for a genuine enqueued ack (unchanged behavior)", () => {
		expect(pollinateNoteFromAck({ triggered: true, status: "enqueued" })).toBe("consolidating…");
	});

	it("keeps the honest skip copy for a declined ack with another reason (unchanged behavior)", () => {
		expect(pollinateNoteFromAck({ triggered: false, status: "skipped", reason: "provider off" })).toBe("skipped · provider off");
		expect(pollinateNoteFromAck({ triggered: false, status: "skipped" })).toBe("skipped · unavailable");
	});
});

describe("PollinateAckSchema (ISS-013: defensive parsing across daemon versions)", () => {
	it("parses an OLD daemon body (no tokens/threshold fields) unchanged", () => {
		const parsed = PollinateAckSchema.parse({ triggered: true, status: "running" });
		expect(parsed.triggered).toBe(true);
		expect(parsed.status).toBe("running");
		expect(parsed.tokens).toBeUndefined();
		expect(parsed.threshold).toBeUndefined();
	});

	it("parses a NEW daemon below-threshold body with the progress fields", () => {
		const parsed = PollinateAckSchema.parse({ triggered: false, status: "below-threshold", tokens: 1200, threshold: 50000 });
		expect(parsed.status).toBe("below-threshold");
		expect(parsed.tokens).toBe(1200);
		expect(parsed.threshold).toBe(50000);
	});

	it("degrades malformed progress fields to undefined instead of throwing into React", () => {
		const parsed = PollinateAckSchema.parse({ triggered: false, status: "below-threshold", tokens: "lots", threshold: null });
		expect(parsed.status).toBe("below-threshold");
		expect(parsed.tokens).toBeUndefined();
		expect(parsed.threshold).toBeUndefined();
	});
});
