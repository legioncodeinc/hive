// @vitest-environment jsdom
/**
 * PRD-015 — HiveGraphPage UI (route-mounted page behaviors).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ScopeContext, type ScopeContextValue } from "../../src/dashboard/web/scope-context.js";
import { HiveGraphPage } from "../../src/dashboard/web/pages/hive-graph.js";
import type { PageProps } from "../../src/dashboard/web/page-frame.js";
import {
	EMPTY_GRAPH,
	EMPTY_HIVE_GRAPH_STATUS,
	EMPTY_NECTAR_PROJECTS,
	type HiveGraphBuildAck,
	type HiveGraphFileGraphWire,
	type HiveGraphSearchResultWire,
	type HiveGraphStatusResultWire,
	type NectarProjectsWire,
	type WireClient,
} from "../../src/dashboard/web/wire.js";

function scopeWithProject(): ScopeContextValue {
	return {
		scope: { org: "local", workspace: "default", project: "proj-1" },
		setScope: () => {},
	};
}

function defaultNectarProjects(): NectarProjectsWire {
	return {
		globalBrooding: "on",
		projects: [
			{
				projectId: "proj-1",
				name: "demo",
				path: "/home/user/demo",
				brooding: "active",
				watcher: "running",
				counts: { described: 1, pending: 0 },
			},
		],
		unreachable: false,
	};
}

function makeWire(overrides: Partial<WireClient> = {}): WireClient {
	const graphPayload: HiveGraphFileGraphWire = {
		graph: {
			built: true,
			nodes: [{ id: "n1", label: "src/a.ts", kind: "ts" }],
			edges: [],
		},
		files: {
			n1: {
				content_hash: "a".repeat(64),
				path: "src/a.ts",
				title: "a",
				description: "Login helper",
				concepts: [],
				describe_model: "m",
				described_at: "2026-07-02T00:00:00.000Z",
			},
		},
		derived: {},
		unreachable: false,
	};
	const statusPayload: HiveGraphStatusResultWire = {
		queueDepth: 2,
		describeStatus: { pending: 2, described: 5, failed: 0, "skipped-too-large": 0, "skipped-binary": 0, "skipped-deleted": 0 },
		costSpentUsd: 0.5,
		degraded: false,
		unreachable: false,
	};
	return {
		hiveGraphFileGraph: vi.fn(async () => graphPayload),
		hiveGraphStatus: vi.fn(async () => statusPayload),
		hiveGraphSearch: vi.fn(async (): Promise<HiveGraphSearchResultWire> => ({
			hits: [{ source: "nectar", id: "n1", path: "src/a.ts", title: "a", body: "Login helper", concepts: "", content_hash: "a".repeat(64) }],
			sources: ["nectar"],
			degraded: true,
			unreachable: false,
		})),
		hiveGraphBuild: vi.fn(async (): Promise<HiveGraphBuildAck> => ({ state: "accepted", message: "Build triggered" })),
		nectarProjects: vi.fn(async () => defaultNectarProjects()),
		setupTenancy: vi.fn(async () => ({
			pending: false,
			selected: true,
			authenticated: true,
			org: { id: "local", name: "local" },
			workspace: { id: "default", name: "default" },
			unreachable: false,
		})),
		setNectarBrooding: vi.fn(async () => defaultNectarProjects()),
		bindProject: vi.fn(async () => ({ bound: true, path: "/home/user/new-repo", projectId: "proj-new", error: undefined })),
		fsBrowse: vi.fn(async () => ({
			path: "/home/user/new-repo",
			parent: "/home/user",
			children: [],
			error: undefined,
		})),
		...overrides,
	} as unknown as WireClient;
}

function renderPage(wire: WireClient, scope: ScopeContextValue = scopeWithProject()): void {
	const props: PageProps = { wire, daemonUp: true, assetBase: "assets" };
	render(
		<ScopeContext.Provider value={scope}>
			<HiveGraphPage {...props} />
		</ScopeContext.Provider>,
	);
}

describe("HiveGraphPage", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("015-AC-1 a-AC-1 renders Hive Graph page frame with project selected", async () => {
		renderPage(makeWire());
		await waitFor(() => expect(screen.getByText("Hive Graph")).toBeTruthy());
		expect(screen.getByTestId("hive-graph-status-widgets")).toBeTruthy();
	});

	it("015-AC-4 c-AC-4 disables search without a project (needs-selection)", async () => {
		renderPage(makeWire(), { scope: { org: "local", workspace: "default" }, setScope: () => {} });
		expect(screen.getByTestId("needs-project-selection")).toBeTruthy();
	});

	it("015-AC-4 c-AC-2 renders search hits and degraded footer", async () => {
		renderPage(makeWire());
		await waitFor(() => expect(screen.getByTestId("hive-graph-search-input")).toBeTruthy());
		fireEvent.change(screen.getByTestId("hive-graph-search-input"), { target: { value: "login" } });
		fireEvent.click(screen.getByTestId("hive-graph-search-submit"));
		await waitFor(() => expect(screen.getByTestId("hive-graph-search-degraded")).toBeTruthy());
		expect(screen.getByText("Login helper")).toBeTruthy();
	});

	it("015-AC-5 c-AC-5 maps status widgets from hiveGraphStatus", async () => {
		renderPage(makeWire());
		await waitFor(() => expect(screen.getByTestId("hive-graph-status-widgets")).toBeTruthy());
		expect(screen.getByTestId("hive-graph-status-widgets").textContent).toContain("queue 2");
		expect(screen.getByTestId("hive-graph-status-widgets").textContent).toContain("described 5");
	});

	it("015-AC-6 b-AC-10 shows unavailable states when nectar is down", async () => {
		const wire = makeWire({
			hiveGraphFileGraph: vi.fn(async () => ({ graph: EMPTY_GRAPH, files: {}, derived: {}, unreachable: true })),
			hiveGraphStatus: vi.fn(async () => ({ ...EMPTY_HIVE_GRAPH_STATUS, unreachable: true })),
			hiveGraphSearch: vi.fn(async () => ({ hits: [], sources: [], degraded: true, unreachable: true })),
		});
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("hive-graph-empty-state")).toBeTruthy());
		expect(screen.getByTestId("hive-graph-empty-state").textContent).toContain("unreachable");
		fireEvent.change(screen.getByTestId("hive-graph-search-input"), { target: { value: "x" } });
		fireEvent.click(screen.getByTestId("hive-graph-search-submit"));
		await waitFor(() => expect(screen.getByTestId("hive-graph-search-unavailable")).toBeTruthy());
		expect(screen.getByTestId("hive-graph-status-unavailable")).toBeTruthy();
	});

	it("c-AC-1 renders needs-project empty state with FolderPicker when nectar has zero projects", async () => {
		const wire = makeWire({
			nectarProjects: vi.fn(async () => ({ ...EMPTY_NECTAR_PROJECTS, unreachable: false })),
		});
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("nectar-needs-project")).toBeTruthy());
		expect(screen.getByTestId("folder-picker")).toBeTruthy();
		expect(screen.queryByTestId("nectar-project-row")).toBeNull();
	});

	it("c-AC-2 re-lists after bind and shows the new active project", async () => {
		const nectarProjects = vi
			.fn()
			.mockResolvedValueOnce({ ...EMPTY_NECTAR_PROJECTS, unreachable: false })
			.mockResolvedValue({
				globalBrooding: "on",
				unreachable: false,
				projects: [
					{
						projectId: "proj-new",
						name: "new-repo",
						path: "/home/user/new-repo",
						brooding: "active",
						watcher: "running",
						counts: { described: 0, pending: 0 },
					},
				],
			});
		const wire = makeWire({ nectarProjects });
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("folder-picker")).toBeTruthy());
		fireEvent.click(screen.getByTestId("select-current"));
		fireEvent.change(screen.getByTestId("picker-name"), { target: { value: "new-repo" } });
		fireEvent.click(screen.getByTestId("picker-bind"));
		await waitFor(() => expect(wire.bindProject).toHaveBeenCalled());
		await waitFor(() => expect(screen.getByTestId("nectar-project-row")).toBeTruthy());
		expect(screen.getByTestId("nectar-brooding-badge").textContent).toBe("brooding");
		expect(nectarProjects.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("c-AC-3 shows brooding badge and toggle on an active project row", async () => {
		renderPage(makeWire());
		await waitFor(() => expect(screen.getByTestId("nectar-project-row")).toBeTruthy());
		expect(screen.getByTestId("nectar-brooding-badge").textContent).toBe("brooding");
		expect(screen.getByTestId("nectar-brooding-toggle")).toBeTruthy();
	});

	it("c-AC-4 reflects persisted brooding state after toggle and re-list", async () => {
		let projectsState: NectarProjectsWire = defaultNectarProjects();
		const nectarProjects = vi.fn(async () => projectsState);
		const setNectarBrooding = vi.fn(async (body) => {
			if ("projectId" in body && body.brooding === "off") {
				projectsState = {
					...projectsState,
					projects: [{ ...projectsState.projects[0]!, brooding: "paused" }],
				};
			}
			return projectsState;
		});
		const wire = makeWire({ nectarProjects, setNectarBrooding });
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("nectar-brooding-toggle")).toBeTruthy());
		fireEvent.click(screen.getByTestId("nectar-brooding-toggle"));
		await waitFor(() => expect(setNectarBrooding).toHaveBeenCalledWith({ projectId: "proj-1", brooding: "off" }));
		await waitFor(() => expect(screen.getByTestId("nectar-brooding-badge").textContent).toBe("paused"));
		expect(nectarProjects.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("c-AC-5 global pause sets every row to global-paused then restores per-project state", async () => {
		const activeTwo: NectarProjectsWire = {
			globalBrooding: "on",
			unreachable: false,
			projects: [
				{ ...defaultNectarProjects().projects[0]!, brooding: "active" },
				{
					projectId: "proj-2",
					name: "other",
					path: "/other",
					brooding: "active",
					watcher: "running",
					counts: { described: 0, pending: 0 },
				},
			],
		};
		const pausedAll: NectarProjectsWire = {
			globalBrooding: "paused",
			unreachable: false,
			projects: activeTwo.projects.map((p) => ({ ...p, brooding: "global-paused" as const, watcher: "stopped" })),
		};
		let projectsState: NectarProjectsWire = activeTwo;
		const nectarProjects = vi.fn(async () => projectsState);
		const setNectarBrooding = vi.fn(async (body) => {
			if ("global" in body && body.global === "paused") projectsState = pausedAll;
			if ("global" in body && body.global === "on") projectsState = activeTwo;
			return projectsState;
		});
		const wire = makeWire({ nectarProjects, setNectarBrooding });
		renderPage(wire);
		await waitFor(() => expect(screen.getAllByTestId("nectar-project-row").length).toBe(2));
		fireEvent.click(screen.getByTestId("nectar-global-brooding-toggle"));
		await waitFor(() => expect(setNectarBrooding).toHaveBeenCalledWith({ global: "paused" }));
		await waitFor(() => {
			const badges = screen.getAllByTestId("nectar-brooding-badge");
			expect(badges.every((el) => el.textContent === "global-paused")).toBe(true);
		});
		fireEvent.click(screen.getByTestId("nectar-global-brooding-toggle"));
		await waitFor(() => expect(setNectarBrooding).toHaveBeenCalledWith({ global: "on" }));
		await waitFor(() => expect(screen.getAllByTestId("nectar-brooding-badge")[0]?.textContent).toBe("brooding"));
	});

	it("c-AC-6 marks nectar unreachable and disables brooding toggles", async () => {
		const wire = makeWire({
			nectarProjects: vi.fn(async () => ({ ...EMPTY_NECTAR_PROJECTS, unreachable: true })),
		});
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("nectar-projects-unreachable")).toBeTruthy());
		expect((screen.getByTestId("nectar-global-brooding-toggle") as HTMLButtonElement).disabled).toBe(true);
	});

	it("tv-AC-6 renders the panel tenancy line naming the fleet credential tenancy when the projects body carries no tenancy fields", async () => {
		renderPage(makeWire());
		await waitFor(() => expect(screen.getByTestId("nectar-projects-tenancy")).toBeTruthy());
		// makeWire's setupTenancy reports local · default; the body carries no fields, so the line
		// falls back to the fleet-shared credential's tenancy, labeled as such (tv-AC-8 at render).
		expect(screen.getByTestId("nectar-projects-tenancy").textContent).toContain("local · default (fleet credential)");
	});

	it("tv-AC-6 prefers the projects body's tenancy fields when nectar reports them", async () => {
		const wire = makeWire({
			nectarProjects: vi.fn(async () => ({
				...defaultNectarProjects(),
				tenancyOrgName: "Nectar Org",
				tenancyWorkspaceName: "Nectar WS",
			})),
		});
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("nectar-projects-tenancy")).toBeTruthy());
		expect(screen.getByTestId("nectar-projects-tenancy").textContent).toContain("Nectar Org · Nectar WS");
		expect(screen.getByTestId("nectar-projects-tenancy").textContent).not.toContain("fleet credential");
	});

	it("tv-AC-7 renders NO tenancy line when nectar is unreachable (the unreachable message stands alone)", async () => {
		const wire = makeWire({
			nectarProjects: vi.fn(async () => ({ ...EMPTY_NECTAR_PROJECTS, unreachable: true })),
		});
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("nectar-projects-unreachable")).toBeTruthy());
		expect(screen.queryByTestId("nectar-projects-tenancy")).toBeNull();
	});

	it("c-AC-7 renders names and paths as escaped text without executing markup", async () => {
		const xss = '<img src=x onerror=alert(1)>';
		const wire = makeWire({
			nectarProjects: vi.fn(async () => ({
				globalBrooding: "on",
				unreachable: false,
				projects: [
					{
						projectId: "xss-id",
						name: xss,
						path: xss,
						brooding: "active",
						watcher: "running",
						counts: { described: 0, pending: 0 },
					},
				],
			})),
		});
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("nectar-project-name").textContent).toBe(xss));
		expect(screen.getByTestId("nectar-project-path").textContent).toBe(xss);
		expect(document.querySelector("img[src='x']")).toBeNull();
	});
});
