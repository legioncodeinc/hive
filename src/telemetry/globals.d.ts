/**
 * Ambient declarations for the build-time PostHog ingest tokens.
 *
 * The esbuild step (esbuild.config.mjs) replaces these identifiers with string
 * literals via `define` when it stamps dist/telemetry/emit.js. Both are declared
 * `string | undefined` so the `typeof` guards in emit.ts are required in code:
 * a tsc-only dev build (no define pass) falls through to the disabled/default
 * path and `tsc --noEmit` plus `vitest run` stay green without a stamped build.
 */

declare var __HONEYCOMB_POSTHOG_KEY__: string | undefined;
declare var __HONEYCOMB_POSTHOG_HOST__: string | undefined;
