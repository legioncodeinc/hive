// hive dashboard bundler — PRD-001b Wave 2.
//
// Bundles the migrated React SPA for the BROWSER: React + ReactDOM are bundled IN
// (NO unpkg/CDN React), JSX is compiled at build time (NO @babel/standalone /
// type="text/babel"). The daemon host (`src/daemon/dashboard/host.ts`) serves the
// produced `dist/daemon/dashboard/app.js` as a single static <script> beside the
// index shell.
//
// It is compiled DIRECTLY from the .tsx source (esbuild does the TS/JSX transform),
// not from tsc's dist output — the web tree is browser code, not part of the node
// graph. `platform: "browser"` + `format: "esm"` (the shell loads it via
// <script type="module">). Nothing is external: a browser bundle must be fully
// self-contained. `jsx: automatic` matches the source's react-jsx runtime.

import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Single source of truth for any injected version: the package.json version. The
// browser tree carries no version define today, but reading it here (never a
// hardcoded string) keeps the build honest if one is added.
const VERSION = JSON.parse(readFileSync("package.json", "utf-8")).version;

const outdir = join(process.cwd(), "dist", "daemon", "dashboard");
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: { app: "src/dashboard/web/main.tsx" },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  jsx: "automatic",
  outdir,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  minify: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry define stamping (mirrors doctor's esbuild define pattern).
//
// The node-side code ships as tsc output; only the telemetry chokepoint carries
// build-time tokens, so esbuild re-emits that ONE file in place with `define`
// substituting __HONEYCOMB_POSTHOG_KEY__ / __HONEYCOMB_POSTHOG_HOST__. Each is
// sourced from a CI env var with a safe default and JSON.stringify'd into the
// define map. An UNSET key compiles to "", which the chokepoint's Gate 1 treats
// as HARD-DISABLED (fail-soft): a local/fork build that never sets these emits
// nothing. The key is a PUBLIC write-only ingest key, embedded in the published
// tarball BY DESIGN; the CI secret only keeps it out of logs and fork PRs. NO
// real key is ever committed to source; it arrives ONLY via CI env at build
// time (.github/workflows/release.yaml).
// ─────────────────────────────────────────────────────────────────────────────

const HONEYCOMB_POSTHOG_KEY = process.env.HONEYCOMB_POSTHOG_KEY ?? "";
const HONEYCOMB_POSTHOG_HOST = process.env.HONEYCOMB_POSTHOG_HOST ?? "";

await build({
  entryPoints: { "telemetry/emit": "dist/telemetry/emit.js" },
  bundle: false,
  platform: "node",
  format: "esm",
  outdir: "dist",
  allowOverwrite: true,
  define: {
    __HONEYCOMB_POSTHOG_KEY__: JSON.stringify(HONEYCOMB_POSTHOG_KEY),
    __HONEYCOMB_POSTHOG_HOST__: JSON.stringify(HONEYCOMB_POSTHOG_HOST)
  }
});

// Status to stderr (not stdout) so callers parsing build output as data don't get
// log noise mixed into their pipe.
console.error(`Built: 1 dashboard-web bundle → dist/daemon/dashboard/app.js @ ${VERSION}`);
console.error(
  `Stamped: dist/telemetry/emit.js (posthog key ${HONEYCOMB_POSTHOG_KEY.length > 0 ? "SET" : "empty = disabled"})`
);
