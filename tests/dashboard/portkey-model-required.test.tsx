// @vitest-environment jsdom
/**
 * ISS-005 (UI slice): the daemon refuses `portkey.enabled = true` without a stored `activeModel`
 * (an empty model once reached the gateway as `model: ""` on every extraction call). The Portkey
 * section must surface the requirement BEFORE the toggle is tried and surface the daemon's
 * rejection when it is tried anyway; the Settings model row must name the requirement for
 * Portkey's open-ended catalog.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { PortkeyGatewaySection, SETTING_KEY } from "../../src/dashboard/web/panels.js";

afterEach(() => {
	cleanup();
});

function renderSection(
	settings: Record<string, unknown>,
	onSaveSetting: (key: string, value: unknown) => Promise<boolean> = async () => true,
): void {
	render(
		<PortkeyGatewaySection
			settings={settings as never}
			secretNames={[]}
			onSaveSetting={onSaveSetting as never}
			onSaveKey={async () => true}
		/>,
	);
}

describe("PortkeyGatewaySection (ISS-005: model required before enable)", () => {
	it("shows the proactive requirement badge when disabled with no stored model", () => {
		renderSection({ [SETTING_KEY.portkeyEnabled]: false });
		expect(screen.getByText(/model required — set one in Settings above/i)).toBeTruthy();
	});

	it("hides the proactive badge once a model is stored", () => {
		renderSection({
			[SETTING_KEY.portkeyEnabled]: false,
			[SETTING_KEY.activeModel]: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		});
		expect(screen.queryByText(/model required/i)).toBeNull();
	});

	it("surfaces the daemon's rejection when enabling is refused", async () => {
		const saves: Array<{ key: string; value: unknown }> = [];
		renderSection({ [SETTING_KEY.portkeyEnabled]: false }, async (key, value) => {
			saves.push({ key, value });
			return false; // daemon 400s: no model stored
		});
		fireEvent.click(screen.getByLabelText("portkey enabled"));
		await waitFor(() => {
			expect(screen.getByText(/daemon rejected: set a model first/i)).toBeTruthy();
		});
		expect(saves).toEqual([{ key: SETTING_KEY.portkeyEnabled, value: true }]);
	});

	it("no rejection note on a successful enable", async () => {
		renderSection(
			{
				[SETTING_KEY.portkeyEnabled]: false,
				[SETTING_KEY.activeModel]: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
			},
			async () => true,
		);
		fireEvent.click(screen.getByLabelText("portkey enabled"));
		await waitFor(() => {
			expect(screen.queryByText(/daemon rejected/i)).toBeNull();
		});
	});
});
