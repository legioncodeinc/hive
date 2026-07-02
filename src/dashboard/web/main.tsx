/**
 * The dashboard web-app ENTRY — PRD-024 Wave 2 (AC-1, D-1) · PRD-037b (renders the multi-page Shell)
 * · PRD-003c (m-AC-6 / m-AC-7 / m-AC-8, the server-gated boot).
 *
 * This is the esbuild bundle entry. esbuild compiles the JSX at BUILD time and bundles
 * React + ReactDOM in (no CDN React, no `@babel/standalone`, no `type="text/babel"` — the
 * three things the UI kit's `index.html` did that D-1 forbids). The host serves the produced
 * bundle as a single static `<script>`; this module finds `#root` (created by the host shell HTML)
 * and mounts the screen the SERVER already authorized for the current path.
 *
 * PRD-003a moved the landing decision (fleet health, then auth) onto hive's server gate
 * (`hive/src/daemon/gate.ts`): every request either gets redirected to `/buzzing` or `/login`
 * before the shell ever renders, or is served the shell for the path it actually requested. This
 * RETIRES the nested `<ReadinessSplash>` → `<SetupGate>` pre-mount gate that used to make that
 * decision client-side (m-AC-6): this module now does a single, path-keyed lookup
 * ({@link resolveBootScreen}) and mounts exactly one top-level screen — no polling-driven swap, no
 * risk of flashing the wrong screen before a client gate resolves.
 *
 * The host stamps the asset base path onto `#root` as `data-asset-base` so the app knows
 * where the host serves the DS logo (loopback, no secret in the attribute).
 */

import React from "react";
import { createRoot } from "react-dom/client";

import { Shell } from "./app.js";
import { resolveBootScreen } from "./boot-route.js";
import { BuzzingScreen } from "./buzzing-screen.js";
import { LoginScreen } from "./setup-gate.js";

/** Mount the screen the server already authorized for `location.pathname`. Idempotent-safe per load. */
function mount(): void {
	const root = document.getElementById("root");
	if (root === null) return;
	// Sanitize the DOM-read base path before it flows into any asset `src` (e.g. the sidebar
	// mark `<img>`). Only a safe relative path is allowed — letters/digits/`. _ - /` — so a value
	// carrying a scheme (`javascript:`) or markup meta-characters can never reach a URL/HTML sink.
	// The host (not the user) sets `data-asset-base`, but this hard barrier closes the DOM-text→sink
	// taint flow by construction (CodeQL js/xss-through-dom) and fails safe to the default.
	const rawAssetBase = root.getAttribute("data-asset-base") ?? "assets";
	const assetBase = /^[A-Za-z0-9._/-]*$/.test(rawAssetBase) ? rawAssetBase : "assets";

	// PRD-003c (m-AC-6/7/8): the boot decision is a PURE lookup from the already-server-authorized
	// path, not a re-derivation of health/auth. `/buzzing` and `/login` are the two gate-exempt
	// screens; every other path mounts the authenticated Shell (its own path router then resolves
	// the specific registry page — PRD-003c m-AC-1 through m-AC-5).
	const pathname = typeof window === "undefined" ? "/" : window.location.pathname;
	const screen = resolveBootScreen(pathname);

	const element =
		screen === "buzzing" ? (
			<BuzzingScreen assetBase={assetBase} />
		) : screen === "login" ? (
			<LoginScreen assetBase={assetBase} />
		) : (
			<Shell assetBase={assetBase} />
		);

	createRoot(root).render(<React.StrictMode>{element}</React.StrictMode>);
}

mount();
