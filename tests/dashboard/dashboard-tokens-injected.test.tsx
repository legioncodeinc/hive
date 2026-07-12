// @vitest-environment jsdom
/**
 * ISS-010 — the Dashboard KPI band's third tile is the MEASURED "Tokens injected" figure
 * (bound to `kpis.injectedTokens`, toLocaleString + "tok" unit), and the old corpus-wide
 * `estimatedSavings` estimate stays honest but SUBORDINATE as a small caption on the same
 * tile ("corpus ~N tok") — not deleted, not the headline.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { DashboardPage } from "../../src/dashboard/web/pages/dashboard.js";
import type { PageProps } from "../../src/dashboard/web/page-frame.js";
import { clearSwrCache } from "../../src/dashboard/web/use-swr.js";
import type { KpisWire, WireClient } from "../../src/dashboard/web/wire.js";

const KPIS: KpisWire = {
	memoryCount: 7,
	sessionCount: 3,
	turnCount: 3,
	estimatedSavings: 48210,
	teamSkillCount: 2,
	injectedTokens: 12345,
};

/** A stub wire covering every read the Dashboard page touches; only `kpis` carries data. */
function stubWire(kpis: KpisWire): WireClient {
	return {
		kpis: vi.fn(async () => kpis),
		sessions: vi.fn(async () => []),
		rules: vi.fn(async () => []),
		skills: vi.fn(async () => []),
		harnesses: vi.fn(async () => []),
		harnessConnectionStatus: vi.fn(async () => []),
		recall: vi.fn(async () => ({ memories: [], degraded: false })),
	} as unknown as WireClient;
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets" };
}

beforeEach(() => {
	clearSwrCache();
});

afterEach(() => {
	cleanup();
});

describe("Dashboard 'Tokens injected' KPI tile (ISS-010)", () => {
	it("binds the tile to kpis.injectedTokens (toLocaleString, 'tok' unit)", async () => {
		render(<DashboardPage {...pageProps(stubWire(KPIS))} />);
		await waitFor(() => expect(screen.getByText("Tokens injected")).toBeTruthy());
		expect(screen.getByText((12345).toLocaleString())).toBeTruthy();
	});

	it("keeps the corpus estimate as the tile's subordinate caption, not the headline", async () => {
		render(<DashboardPage {...pageProps(stubWire(KPIS))} />);
		await waitFor(() => expect(screen.getByText("Tokens injected")).toBeTruthy());
		expect(screen.getByText(`corpus ~${(48210).toLocaleString()} tok`)).toBeTruthy();
		// The old headline label is gone — the estimate no longer masquerades as the KPI.
		expect(screen.queryByText("Est. savings")).toBeNull();
	});

	it("renders 0 (not a crash / blank) when an OLD daemon sends no injectedTokens (wire default)", async () => {
		// EMPTY-shaped KPIs — what the wire's `.catch(0)` produces for an old daemon payload.
		render(<DashboardPage {...pageProps(stubWire({ ...KPIS, injectedTokens: 0 }))} />);
		await waitFor(() => expect(screen.getByText("Tokens injected")).toBeTruthy());
		expect(screen.getByText("0")).toBeTruthy();
	});
});
