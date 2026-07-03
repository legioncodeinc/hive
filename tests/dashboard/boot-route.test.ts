/**
 * PRD-003c (m-AC-6 / m-AC-7 / m-AC-8) — `resolveBootScreen` is `main.tsx`'s WHOLE boot decision: a
 * pure, path-keyed lookup that never re-derives health or auth (that would resurrect the retired
 * `ReadinessSplash`→`SetupGate` nested client gate the server-side gate replaced, PRD-003a).
 */

import { BUZZING_PATH, LOGIN_PATH, ONBOARDING_PATH, resolveBootScreen } from "../../src/dashboard/web/boot-route.js";

describe("resolveBootScreen", () => {
	it("m-AC-7 resolves /buzzing to the buzzing screen", () => {
		expect(resolveBootScreen(BUZZING_PATH)).toBe("buzzing");
		expect(resolveBootScreen("/buzzing")).toBe("buzzing");
	});

	it("m-AC-8 resolves /login to the login screen", () => {
		expect(resolveBootScreen(LOGIN_PATH)).toBe("login");
		expect(resolveBootScreen("/login")).toBe("login");
	});

	it("ob-AC-1 resolves /onboarding to the onboarding screen", () => {
		expect(resolveBootScreen(ONBOARDING_PATH)).toBe("onboarding");
		expect(resolveBootScreen("/onboarding")).toBe("onboarding");
	});

	it("m-AC-6 resolves every other path (including `/` and every registry route) to the shell", () => {
		for (const path of ["/", "/projects", "/harnesses", "/memories", "/graph", "/sync", "/logs", "/roi", "/settings"]) {
			expect(resolveBootScreen(path)).toBe("shell");
		}
	});

	it("resolves an unknown path to the shell (the registry's own unknown→Dashboard fallback then applies)", () => {
		expect(resolveBootScreen("/does-not-exist")).toBe("shell");
	});
});
