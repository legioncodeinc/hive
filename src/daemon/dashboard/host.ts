/**
 * The viewable dashboard HOST — PRD-001b Wave 2.
 *
 * Adapted from honeycomb `src/daemon/runtime/dashboard/host.ts`. thehive is a standalone Hono
 * process that serves the migrated React SPA at the ROOT (`/`), not under `/dashboard`. It serves
 * the INDEX SHELL of the real React app bundled production-clean by esbuild
 * (`src/dashboard/web/main.tsx` → `dist/daemon/dashboard/app.js`). The shell is `<div id="root">`
 * plus a `<link>` to the design-system CSS and a `<script>` to the bundled app; the app then
 * hydrates ITSELF from the daemon endpoints its `wire` targets.
 *
 * NO `unpkg`/CDN React, NO in-browser `@babel/standalone`, NO `type="text/babel"`: the shell
 * references ONLY same-origin loopback assets the host serves, and carries NO token/secret.
 *
 * ── The five routes this host registers (thehive serves at the root) ──────────
 *   GET /                              → the index shell ({@link renderShell})
 *   GET /app.js                       → the esbuild bundle (React + ReactDOM + the app)
 *   GET /styles.css                   → the concatenated design-system CSS
 *   GET /honeycomb-memory-cluster.svg → the brand mark
 *   GET /fonts/:name                  → an allow-listed brand font
 */

import type { Hono } from "hono";
import { createWebAssets, type WebAssets } from "./web-assets.js";

/** The route the viewable dashboard shell is served at (thehive serves at the root). */
export const DASHBOARD_HOST_PATH = "/" as const;

/** The same-origin path the host serves the bundled app JS at. */
export const DASHBOARD_APP_PATH = "/app.js" as const;

/** The same-origin path the host serves the concatenated design-system CSS at. */
export const DASHBOARD_CSS_PATH = "/styles.css" as const;

/** The same-origin path the host serves the brand mark at. */
export const DASHBOARD_LOGO_PATH = "/honeycomb-memory-cluster.svg" as const;

/**
 * The same-origin path prefix the host serves the brand fonts under. The served DS CSS's
 * `@font-face` URLs are rewritten to this prefix (see `web-assets.ts` `rewriteFontUrls`) so the
 * browser fetches `/fonts/<file>` instead of the unserved on-disk `../logos/fonts/<file>`. The
 * `:name` is matched against a FIXED allow-list in `web-assets.ts` `font()` — anything not in the
 * six known filenames 404s (no attacker-controlled path component).
 */
export const DASHBOARD_FONT_PATH = "/fonts/:name" as const;

/**
 * The asset base the app resolves host-served assets under. thehive serves the mark at the ROOT
 * (`/honeycomb-memory-cluster.svg`), so the base is empty — the app's `${assetBase}/…svg`
 * resolves to `/…svg`. main.tsx sanitizes this DOM-read value; an empty string is the safe default.
 */
const ASSET_BASE = "" as const;

/** Options for {@link mountDashboardHost}. */
export interface MountDashboardHostOptions {
	/**
	 * The web-asset reader (the CSS/logo/bundle/fonts source). Defaults to {@link createWebAssets}
	 * (resolve the repo `assets/` + the bundle beside this module). A test injects a fixture reader
	 * so the host suite never depends on the real tree or a built bundle.
	 */
	readonly assets?: WebAssets;
}

/**
 * The static layout CSS the UI kit declares inline (`.wrap`, `.grid2`, `.kpirow`, `.mem-enter`,
 * `.col`). Ported verbatim so the served page lays out exactly like honeycomb's. The DS TOKENS +
 * component styles come from the linked `/styles.css`; this is only the page's grid/animation rules.
 */
const LAYOUT_CSS = [
	"body { margin: 0; background: var(--bg-canvas); min-height: 100vh; }",
	".wrap { max-width: 1180px; margin: 0 auto; padding: 28px 28px 48px; }",
	".grid2 { display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; }",
	"@media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }",
	".kpirow { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }",
	"@media (max-width: 720px) { .kpirow { grid-template-columns: repeat(2, 1fr); } }",
	".mem-enter { opacity: 1; }",
	"@media (prefers-reduced-motion: no-preference) {",
	"  .mem-enter { animation: memIn var(--dur-base) var(--ease-out) both; }",
	"  @keyframes memIn { from { transform: translateY(10px); } to { transform: none; } }",
	"}",
	".col { display: flex; flex-direction: column; gap: 16px; }",
].join("\n");

/**
 * Build the index SHELL HTML. It is a COMPLETE page: doctype, head with the DS CSS `<link>` + the
 * inline layout CSS, a `<div id="root">` (the app mounts here) carrying the asset base, and the
 * bundled-app `<script type="module">`. NO inline data, NO token/secret, NO CDN/Babel reference —
 * the bundle is same-origin loopback. The app self-hydrates.
 */
export function renderShell(): string {
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		"<title>The Hive — Dashboard</title>",
		`<link rel="stylesheet" href="${DASHBOARD_CSS_PATH}">`,
		`<link rel="icon" href="${DASHBOARD_LOGO_PATH}">`,
		`<style>${LAYOUT_CSS}</style>`,
		"</head>",
		"<body>",
		`<div id="root" data-asset-base="${ASSET_BASE}"></div>`,
		`<script type="module" src="${DASHBOARD_APP_PATH}"></script>`,
		"</body>",
		"</html>",
	].join("\n");
}

/**
 * Attach the viewable dashboard host onto thehive's Hono app. Registers the shell route plus the
 * four static-asset routes (app JS, CSS, logo, fonts). Call ONCE while constructing the app. The
 * shell carries no secret/token; the asset routes serve only the DS CSS/logo/fonts + the bundle
 * (a not-yet-built bundle 404s rather than 500s).
 */
export function mountDashboardHost(app: Hono, options: MountDashboardHostOptions = {}): void {
	const assets = options.assets ?? createWebAssets();

	// GET / — the index shell (the app mounts into #root and self-hydrates). `no-cache` (revalidate
	// every load): the shell + app.js + css filenames are NOT content-hashed, so an upgrade rebuilds
	// them in place at the SAME URL. Without a revalidation directive the browser heuristically caches
	// the bundle and keeps running a STALE app.js across a restart. `no-cache` forces a re-pull on
	// each load (cheap over loopback), so a rebuilt dashboard is always the one that runs.
	app.get(DASHBOARD_HOST_PATH, (c) => {
		c.header("cache-control", "no-cache");
		return c.html(renderShell());
	});

	// GET /app.js — the esbuild bundle (React + ReactDOM + the dashboard app).
	app.get(DASHBOARD_APP_PATH, (c) => {
		const asset = assets.appJs();
		if (asset === null) return c.text("dashboard bundle not built", 404);
		return c.body(asset.body, 200, { "content-type": asset.contentType, "cache-control": "no-cache" });
	});

	// GET /styles.css — the concatenated design-system CSS.
	app.get(DASHBOARD_CSS_PATH, (c) => {
		const asset = assets.css();
		if (asset === null) return c.text("dashboard styles unavailable", 404);
		return c.body(asset.body, 200, { "content-type": asset.contentType, "cache-control": "no-cache" });
	});

	// GET /honeycomb-memory-cluster.svg — the brand mark. Served `no-cache` too: it shares the
	// un-hashed URL contract with the shell, and revalidating a ~1 KB SVG over loopback is free.
	app.get(DASHBOARD_LOGO_PATH, (c) => {
		const asset = assets.logo();
		if (asset === null) return c.text("dashboard logo unavailable", 404);
		return c.body(asset.body, 200, { "content-type": asset.contentType, "cache-control": "no-cache" });
	});

	// GET /fonts/<file> — the brand fonts. The DS CSS's `@font-face` URLs are rewritten to this
	// route. `:name` is allow-listed in `font()` (only the six known filenames resolve; anything
	// else — incl. traversal — 404s). Fonts carry no secret; a long-lived immutable cache-control.
	app.get(DASHBOARD_FONT_PATH, (c) => {
		const asset = assets.font(c.req.param("name"));
		if (asset === null) return c.text("dashboard font not found", 404);
		return c.body(asset.body, 200, {
			"content-type": asset.contentType,
			"cache-control": "public, max-age=31536000, immutable",
		});
	});
}
