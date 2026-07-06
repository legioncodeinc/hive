/**
 * The SETTINGS page — PRD-044 (the 7th and final page of the dashboard mini-site).
 *
 * Mounted at the PRD-037 `#/settings` slot (the registry already routes it; this fills the
 * `ComingSoon` placeholder). ONE coherent page, THREE sections over the INJECTED `wire` (never
 * `createWireClient`), all on the existing DS tokens + primitives (`Badge`/`Button`/`Input`/
 * `Panel`/`PageFrame`) — NO new design system, NO CDN React, NO in-browser Babel. Every value
 * renders as escaped React text (XSS-safe; never `dangerouslySetInnerHTML`). No token/secret value
 * EVER appears in page state, the DOM, a parsed response, or a log line (D-3 / D-6).
 *
 *   044a — DeepLake auth (SECURITY-CRITICAL, the token is SACRED):
 *     · `DeeplakeAuthSection` reads the REDACTED `wire.authStatus()` (`GET /api/auth/status`) and
 *       renders it TRUTHFULLY: connected org/workspace/agent, the credentials SOURCE
 *       (`env` "via HONEYCOMB_TOKEN" vs `file`), `savedAt`, and expiry ONLY when a real
 *       `expiresAt` exists (else "expiry unknown" — never fabricated). Disconnected → an honest
 *       "Not connected to DeepLake" state. OQ-1 RESOLVED: STATUS-FIRST + a CLI hand-off (the exact
 *       `honeycomb login` commands) — NO in-page device-flow, NO mock success. The section RE-READS
 *       `authStatus()` on a focus/poll so a CLI login reflects here. The token is never rendered.
 *
 *   044b — provider API keys (write-only into the encrypted vault):
 *     · `ProviderKeysSection` renders one row per provider (Anthropic, OpenAI, OpenRouter, Cohere):
 *       a password-type write-only `Input`, a "Save key" `Button`, and a presence `Badge`. A save
 *       POSTs `wire.setSecret(name, value)` (`POST /api/secrets/:name`); presence comes from
 *       `wire.secretNames()` (NAMES only — there is NO value-returning route, ever). On success the
 *       input is CLEARED and `secretNames()` is RE-READ. A secret value never enters page state,
 *       the DOM, the response, or a log line (AC-3 write-only discipline).
 *
 *   044c — search mode + migrated inference settings:
 *     · `SearchAndInferenceSection` renders a NEW recall-mode `Select` (`keyword | semantic |
 *       hybrid` + a "default" option that leaves the `recallMode` key UNSET) PLUS the MIGRATED
 *       provider→model selector + pollinating toggle (the existing `SettingsPanel`, REUSED not forked
 *       — D-5). All persist through the EXISTING `vaultSettings()`/`setSetting()` surface
 *       (persist-then-re-read); `recallMode` adds NO new wire method.
 */

import React from "react";

import { Badge, Button, Input } from "../primitives.js";
import { Panel, PortkeyGatewaySection, PROVIDER_KEY_NAME, SETTING_KEY, SettingsPanel } from "../panels.js";
import type { PageProps } from "../page-frame.js";
import { isTabHidden, PageFrame } from "../page-frame.js";
import { LIFECYCLE_FLAG_REFERENCE } from "../../../shared/lifecycle-flags.js";
import {
	DISCONNECTED_AUTH_STATUS,
	EMPTY_VAULT_SETTINGS,
	type AuthStatusWire,
	type SettingValueWire,
	type SetupLoginWire,
	type UninstallResultWire,
	type VaultSettingsWire,
} from "../wire.js";

/** How often the auth section re-reads `authStatus()` so a CLI login reflects here (ms). */
const AUTH_POLL_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// A shared section shell — a titled Panel with consistent rhythm across the three
// sections (jscpd discipline: one wrapper, not three copies of the same markup).
// ─────────────────────────────────────────────────────────────────────────────

/** One labeled metadata row (a left label + a right value) — shared by the auth section. */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 6px", borderTop: "1px solid var(--border-subtle)" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", minWidth: 120 }}>{label}</span>
			<span style={{ flex: 1 }} />
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", textAlign: "right", wordBreak: "break-word" }}>
				{children}
			</span>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 044a — the DeepLake auth section (status-first + CLI hand-off; token is sacred).
// ─────────────────────────────────────────────────────────────────────────────

/** Human label for the credentials source (`env` → "via HONEYCOMB_TOKEN", honest about the env win). */
function sourceLabel(source: AuthStatusWire["source"]): string {
	if (source === "env") return "via HONEYCOMB_TOKEN";
	if (source === "file") return "saved login (~/.deeplake)";
	return "none";
}

/** Render a token-expiry value HONESTLY: a real `expiresAt` as an ISO instant, else "expiry unknown". */
function expiryLabel(expiresAt: number | undefined): string {
	// `expiresAt` is epoch SECONDS (a real `TokenClaims.exp`); absent → never computed/faked.
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "expiry unknown";
	return new Date(expiresAt * 1000).toISOString();
}

/**
 * The connect affordance — an IN-PAGE device flow (the dashboard is now a peer of the CLI for login).
 * "Connect to DeepLake" POSTs `wire.setupLogin()` (the existing 050c device-flow endpoint) and renders
 * the returned `user_code` + verification link; the daemon polls → mints → persists in the background,
 * and the parent {@link DeeplakeAuthSection}'s `authStatus()` poll flips the section to connected the
 * moment the credential lands — same tab, no `honeycomb login`. The exact CLI command is kept as a
 * secondary hint. NO token ever crosses the wire (the setup-login schema has no token field).
 */
function ConnectHandoff({ wire }: { wire: PageProps["wire"] }): React.JSX.Element {
	const [grant, setGrant] = React.useState<SetupLoginWire | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState(false);
	// A synchronous in-flight guard so a rapid double-click never starts two device flows.
	const inFlightRef = React.useRef(false);

	const begin = React.useCallback(async (): Promise<void> => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setBusy(true);
		setError(false);
		const result = await wire.setupLogin();
		if (result === null) {
			setError(true);
			setBusy(false);
			inFlightRef.current = false;
			return;
		}
		// Leave `busy` true: the section now waits for the background `authStatus()` poll to flip to
		// connected once the credential lands. The button stays disabled meanwhile.
		setGrant(result);
	}, [wire]);

	return (
		<div data-testid="auth-connect" style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 6px" }}>
			<span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Not connected to DeepLake.</span>
			{grant === null ? (
				<>
					<Button variant="primary" size="sm" disabled={busy} onClick={() => void begin()} data-testid="auth-connect-button">
						{busy ? "Starting…" : "Connect to DeepLake"}
					</Button>
					{error && (
						<span data-testid="auth-connect-error" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--severity-critical)" }}>
							Could not start sign-in. Retry, or run <code>honeycomb login</code> in your terminal.
						</span>
					)}
				</>
			) : (
				<div data-testid="auth-connect-grant" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					<span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Enter this code to finish signing in:</span>
					<code style={{ fontFamily: "var(--font-mono)", fontSize: 16, color: "var(--honey)", letterSpacing: "0.08em" }}>{grant.user_code}</code>
					<a
						href={grant.verification_uri_complete ?? grant.verification_uri}
						target="_blank"
						rel="noreferrer"
						style={{ fontSize: 13, color: "var(--text-secondary)" }}
					>
						Open the verification page
					</a>
					<span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Waiting for you to finish in the browser…</span>
				</div>
			)}
			<span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
				or, from your terminal: <code style={{ fontFamily: "var(--font-mono)", color: "var(--honey)" }}>honeycomb login</code>
			</span>
		</div>
	);
}

/**
 * The DeepLake auth section (044a). Reads the REDACTED `authStatus()` and renders it truthfully —
 * connected identity + source + expiry-when-known, or an honest disconnected state with the CLI
 * hand-off. RE-READS on a poll so a CLI `honeycomb login` reflects here. The token is NEVER
 * rendered (the wire schema has no token field by construction).
 */
export function DeeplakeAuthSection({ wire }: { wire: PageProps["wire"] }): React.JSX.Element {
	const [status, setStatus] = React.useState<AuthStatusWire>(DISCONNECTED_AUTH_STATUS);
	const [loading, setLoading] = React.useState(true);
	const [loggingOut, setLoggingOut] = React.useState(false);

	const load = React.useCallback(async (): Promise<void> => {
		// `authStatus()` never throws — it degrades to DISCONNECTED on any failure (AC-4).
		const next = await wire.authStatus();
		setStatus(next);
		setLoading(false);
	}, [wire]);

	// Log out (dashboard action): remove the shared credential through the daemon, then RE-READ the
	// status so the section flips to the disconnected/connect state on success (never an optimistic flip).
	const onLogout = React.useCallback(async (): Promise<void> => {
		setLoggingOut(true);
		await wire.logout();
		await load();
		setLoggingOut(false);
	}, [wire, load]);

	// Fetch on mount + re-read on a poll (so a CLI login reflects here) + on window focus.
	React.useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			if (!alive || isTabHidden()) return; // background-tab pause: no auth poll while hidden (focus still refreshes)
			await load();
		};
		void tick();
		const id = setInterval(() => void tick(), AUTH_POLL_MS);
		const onFocus = (): void => void tick();
		if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
		return () => {
			alive = false;
			clearInterval(id);
			if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
		};
	}, [load]);

	return (
		<Panel
			title="DeepLake"
			eyebrow="auth · org · workspace"
			right={
				<Badge tone={status.connected ? "verified" : "neutral"} mono dot>
					{status.connected ? "connected" : "not connected"}
				</Badge>
			}
		>
			{loading ? (
				<div data-testid="auth-loading" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
					loading…
				</div>
			) : status.connected ? (
				<div data-testid="auth-connected">
					<MetaRow label="org">{status.orgName || status.orgId || "—"}</MetaRow>
					<MetaRow label="org id">{status.orgId || "—"}</MetaRow>
					<MetaRow label="workspace">{status.workspace || "—"}</MetaRow>
					<MetaRow label="agent">{status.agentId || "—"}</MetaRow>
					<MetaRow label="source">{sourceLabel(status.source)}</MetaRow>
					<MetaRow label="last login">{status.savedAt || "unknown"}</MetaRow>
					<MetaRow label="token expiry">{expiryLabel(status.expiresAt)}</MetaRow>
					{/* Log out (dashboard action): remove the shared credential so the user can re-auth here. */}
					<div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 10 }}>
						<Button variant="secondary" size="sm" disabled={loggingOut} onClick={() => void onLogout()} data-testid="auth-logout-button">
							{loggingOut ? "Logging out…" : "Log out"}
						</Button>
					</div>
				</div>
			) : (
				<div data-testid="auth-disconnected">
					<ConnectHandoff wire={wire} />
				</div>
			)}
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 044b — the provider API keys section (write-only into the encrypted vault).
// ─────────────────────────────────────────────────────────────────────────────

/** The four providers this section manages, in display order (label + the conventional key name). */
const PROVIDER_ROWS: readonly { id: string; label: string }[] = [
	{ id: "anthropic", label: "Anthropic (Claude)" },
	{ id: "openai", label: "OpenAI (ChatGPT)" },
	{ id: "openrouter", label: "OpenRouter" },
	{ id: "cohere", label: "Cohere" },
];

/**
 * One provider key row (044b): a label, a write-only password `Input`, a "Save key" `Button`, and
 * a presence `Badge`. The input value lives in a LOCAL draft that is CLEARED on a successful save
 * (never pre-filled — there is no value to fetch). An empty value is rejected client-side BEFORE
 * the POST. The secret value never leaves this row's draft state, never enters the parsed response
 * (the wire returns a boolean), and is never logged.
 */
function ProviderKeyRow({
	id,
	label,
	present,
	onSave,
}: {
	id: string;
	label: string;
	present: boolean;
	onSave: (id: string, value: string) => Promise<boolean>;
}): React.JSX.Element {
	const [draft, setDraft] = React.useState("");
	const [saving, setSaving] = React.useState(false);
	const [rejected, setRejected] = React.useState(false);

	const submit = React.useCallback(async (): Promise<void> => {
		const value = draft;
		// Client-side empty-value reject BEFORE the POST (AC-1) — an empty key is never sent.
		if (value.length === 0) {
			setRejected(true);
			return;
		}
		setSaving(true);
		setRejected(false);
		const ok = await onSave(id, value);
		setSaving(false);
		// Write-only discipline (AC-3): CLEAR the input on a successful save (no lingering value in
		// state), leave it for a retry on a rejected write. Either way the value is never echoed.
		if (ok) {
			setDraft("");
		} else {
			setRejected(true);
		}
	}, [draft, id, onSave]);

	return (
		<div
			data-testid={`provider-row-${id}`}
			style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 6px", borderTop: "1px solid var(--border-subtle)", flexWrap: "wrap" }}
		>
			<span style={{ fontSize: 14, color: "var(--text-primary)", minWidth: 150 }}>{label}</span>
			<div style={{ flex: "1 1 220px", minWidth: 180 }}>
				<Input
					type="password"
					mono
					size="sm"
					value={draft}
					placeholder={present ? "replace key…" : "paste key…"}
					onChange={(e) => {
						setDraft(e.target.value);
						if (rejected) setRejected(false);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") void submit();
					}}
					data-testid={`provider-input-${id}`}
				/>
			</div>
			<Button variant="primary" size="sm" disabled={saving} data-testid={`provider-save-${id}`} onClick={() => void submit()}>
				{saving ? "saving…" : "Save key"}
			</Button>
			<Badge tone={present ? "verified" : "neutral"} mono dot>
				{present ? "key set ✓" : "not set"}
			</Badge>
			{rejected && (
				<span data-testid={`provider-rejected-${id}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--severity-critical)" }}>
					not accepted
				</span>
			)}
		</div>
	);
}

/**
 * The provider API keys section (044b). One row per provider (Anthropic, OpenAI, OpenRouter,
 * Cohere). A save POSTs `setSecret(name, value)` then RE-READS `secretNames()` so the presence
 * badge reflects the persisted truth (mirroring the `setSetting` re-read). There is NO `getSecret`
 * — a stored key cannot be read back. The presence is by NAME only (`PROVIDER_KEY_NAME`).
 */
export function ProviderKeysSection({
	wire,
	secretNames,
	onSaved,
}: {
	wire: PageProps["wire"];
	secretNames: readonly string[];
	onSaved: () => void;
}): React.JSX.Element {
	// The single write path: POST the value (write-only), then re-read names on success so the
	// parent's `secretNames` (and thus the presence badge) reflects the persisted truth. The value
	// is consumed here and never returned/stored beyond the row's draft (which clears on success).
	const onSave = React.useCallback(
		async (id: string, value: string): Promise<boolean> => {
			const keyName = PROVIDER_KEY_NAME[id];
			if (keyName === undefined) return false;
			const ok = await wire.setSecret(keyName, value);
			if (ok) onSaved(); // re-read secretNames (presence) — mirrors saveSetting's re-read.
			return ok;
		},
		[wire, onSaved],
	);

	return (
		<Panel title="Provider keys" eyebrow="write-only · names-only presence">
			<div data-testid="provider-keys">
				{PROVIDER_ROWS.map((p) => {
					const keyName = PROVIDER_KEY_NAME[p.id] ?? "";
					const present = keyName !== "" && secretNames.includes(keyName);
					return <ProviderKeyRow key={p.id} id={p.id} label={p.label} present={present} onSave={onSave} />;
				})}
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 044c — the search mode + migrated inference settings section.
// ─────────────────────────────────────────────────────────────────────────────

/** The recall-mode options: a "default" (unset) plus the three explicit modes (044c). */
const RECALL_MODE_OPTIONS: readonly { value: string; label: string }[] = [
	{ value: "", label: "default (semantic when embeddings on)" },
	{ value: "keyword", label: "keyword — lexical only" },
	{ value: "semantic", label: "semantic — vector (fallback when off)" },
	{ value: "hybrid", label: "hybrid — both arms" },
];

/**
 * The recall-mode selector (044c). A controlled `<select>` whose value is the persisted
 * `recallMode` setting (or "" for the "default" option, which leaves the key UNSET — preserving the
 * PRD-025 runtime default). Choosing a value persists through the EXISTING `setSetting` (no new
 * wire method); the daemon REJECTS any value outside `keyword | semantic | hybrid` (fail-closed).
 */
function RecallModeRow({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 6px", flexWrap: "wrap" }}>
			<div style={{ display: "flex", flexDirection: "column", minWidth: 120 }}>
				<span style={{ fontSize: 14, color: "var(--text-primary)" }}>Search mode</span>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>recall channels</span>
			</div>
			<span style={{ flex: 1 }} />
			<select
				aria-label="search mode"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				data-testid="recall-mode-select"
				style={{
					height: 36,
					padding: "0 10px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-md)",
					color: "var(--text-primary)",
					fontFamily: "var(--font-mono)",
					fontSize: 13,
					minWidth: 220,
				}}
			>
				{RECALL_MODE_OPTIONS.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		</div>
	);
}

/**
 * The search-mode + inference section (044c). Composes the NEW recall-mode selector with the
 * MIGRATED provider/model/pollinating controls (the existing `SettingsPanel`, REUSED verbatim — D-5).
 * Everything persists through the SAME `vaultSettings()`/`setSetting()` surface with a persist-then
 * re-read contract; `recallMode` adds no new wire method.
 *
 * PRD-063a (D-2): when `portkeyEnabled` is true, the provider/model rows are rendered but visually
 * de-emphasized with a "superseded by Portkey" hint. Turning Portkey off restores them without
 * re-entry (the keys are still persisted — only the hint disappears).
 */
export function SearchAndInferenceSection({
	settings,
	catalog,
	secretNames,
	onSave,
	portkeyEnabled,
}: {
	settings: Readonly<Record<string, SettingValueWire>>;
	catalog: VaultSettingsWire["catalog"];
	secretNames: readonly string[];
	onSave: (key: string, value: SettingValueWire) => Promise<boolean>;
	/** PRD-063a D-2: when true, de-emphasize the per-provider rows + activeProvider selector. */
	portkeyEnabled?: boolean;
}): React.JSX.Element {
	// The persisted recall mode (controlled). The "default" option maps to "" → the key stays UNSET
	// (preserving the PRD-025 runtime decision). String() defends against a non-string scalar.
	const recallMode = String(settings[SETTING_KEY.recallMode] ?? "");

	return (
		<Panel title="Search & inference" eyebrow="recall mode · provider · model · pollinating">
			<div data-testid="search-inference">
				<RecallModeRow value={recallMode} onChange={(v) => void onSave(SETTING_KEY.recallMode, v)} />
				{/* PRD-063a D-2: when Portkey is on, label the provider section as superseded. The controls
				    remain visible so the user knows their persisted keys are still there; they are simply
				    de-emphasized so it is clear they are not the active inference path. */}
				{portkeyEnabled === true && (
					<div
						data-testid="portkey-supersedes-hint"
						style={{ padding: "6px 6px 2px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}
					>
						superseded by Portkey — provider keys still stored, not the active inference path
					</div>
				)}
				{/* The MIGRATED provider/model/pollinating panel — REUSED, not forked (D-5). It carries its
				    own Panel shell, so it nests cleanly below the recall-mode row. When Portkey is on, we
				    wrap it in a muted overlay to visually de-emphasize it (opacity only, controls still
				    accessible so the user can read what is stored). */}
				<div style={{ marginTop: 8, opacity: portkeyEnabled === true ? 0.45 : 1, transition: "opacity 0.15s" }}>
					<SettingsPanel catalog={catalog} settings={settings} secretNames={secretNames} onSave={onSave} />
				</div>
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-058d — the lifecycle config REFERENCE section (AC-55d.1.3): every
// `memory.lifecycle.*` flag with its symbol, default, master-equation effect, and
// env override. Read-only on the settings page (the values are governed by
// `agent.yaml` / `HONEYCOMB_LIFECYCLE_*` per the documented precedence); the table
// is the SINGLE-SOURCED {@link LIFECYCLE_FLAG_REFERENCE} the config doc also lists,
// so the symbol/default/effect can never drift between the surface and the doc.
// ─────────────────────────────────────────────────────────────────────────────

/** One flag-reference row (symbol · config path · default · effect · env). Escaped text. */
function LifecycleFlagRow({ symbol, configPath, envOverride, defaultValue, effect }: (typeof LIFECYCLE_FLAG_REFERENCE)[number]): React.JSX.Element {
	return (
		<div data-testid="lifecycle-flag" data-config-path={configPath} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 0", borderBottom: "1px solid var(--border-subtle)" }}>
			<div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
				<Badge tone="honey" mono>
					{symbol}
				</Badge>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", wordBreak: "break-all" }}>{configPath}</span>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>default: {defaultValue}</span>
			</div>
			<div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{effect}</div>
			<div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)" }}>env: {envOverride}</div>
		</div>
	);
}

/**
 * The lifecycle config reference (PRD-058d AC-55d.1.3): the full `memory.lifecycle.*` flag table on the
 * settings page. Each flag shows its symbol, config path, default, master-equation effect, and env
 * override. Read from the single-sourced {@link LIFECYCLE_FLAG_REFERENCE} so the surface and the config
 * doc never drift. Precedence is documented inline (env > yaml > default) per the `HONEYCOMB_PIPELINE_*`
 * precedent. Non-destructive defaults are visible: `a = 1`, `c = 0`, `s = 0`, auto-resolve `false`.
 */
function LifecycleConfigSection(): React.JSX.Element {
	return (
		<Panel title="Memory lifecycle" eyebrow="memory.lifecycle.* · symbol · default · effect">
			<div data-testid="lifecycle-config-reference" style={{ display: "flex", flexDirection: "column" }}>
				<div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", marginBottom: 8 }}>
					Precedence: HONEYCOMB_LIFECYCLE_* env &gt; agent.yaml memory.lifecycle.* &gt; the documented default. Defaults are
					non-destructive — a = 1, c = 0, s = 0 (posture observe), auto-resolve off.
				</div>
				{LIFECYCLE_FLAG_REFERENCE.map((flag) => (
					<LifecycleFlagRow key={flag.configPath} {...flag} />
				))}
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Embeddings on/off (dashboard action) — turn semantic recall on/off LIVE + persisted.
// ─────────────────────────────────────────────────────────────────────────────

/** The honest embeddings state (mirrors the daemon `reasons.embeddingsState`): off | warming | on | failed. */
type EmbeddingsState = "off" | "warming" | "on" | "failed";

/** How often {@link EmbeddingsSection} re-polls `/health` WHILE warming, so the badge auto-advances to on/failed. */
const EMBED_WARMING_POLL_MS = 2500;

/** Render one embeddings state → its badge tone, badge label, and whether embeddings are enabled. */
function embeddingsView(state: EmbeddingsState): { tone: "verified" | "neutral" | "warning" | "critical"; label: string; enabled: boolean } {
	switch (state) {
		case "on":
			return { tone: "verified", label: "on", enabled: true };
		case "warming":
			return { tone: "warning", label: "warming…", enabled: true };
		case "failed":
			return { tone: "critical", label: "failed", enabled: true };
		default:
			return { tone: "neutral", label: "off", enabled: false };
	}
}

/**
 * The embeddings toggle. Reads the HONEST live state from `wire.health()` — `reasons.embeddingsState`
 * (`off | warming | on | failed`), falling back to the coarse `reasons.embeddings` for a pre-honesty
 * daemon. Flips it through `wire.setEmbeddings(...)`, which actuates the daemon's embed supervisor
 * (spawn+warm / stop) AND persists the choice so it survives a restart. Off = lexical (BM25) recall
 * only. The state re-reads from `health()` after a toggle AND polls WHILE `warming` so the badge
 * advances from "warming…" to "on" (or "failed") on its own — never an optimistic flip.
 */
export function EmbeddingsSection({ wire }: { wire: PageProps["wire"] }): React.JSX.Element {
	// `null` while the first health read is in flight (so we never render a wrong default).
	const [state, setState] = React.useState<EmbeddingsState | null>(null);
	const [busy, setBusy] = React.useState(false);

	const load = React.useCallback(async (): Promise<void> => {
		// Fail-soft like the rest of the dashboard: a failed/absent health read degrades to "off"
		// rather than throwing into React (the badge shows off; the toggle still works).
		try {
			const health = await wire.health();
			const reasons = health?.reasons;
			// Prefer the honest fine-grained state; fall back to the coarse enabled/disabled field.
			const next: EmbeddingsState = reasons?.embeddingsState ?? (reasons?.embeddings === "on" ? "on" : "off");
			setState(next);
		} catch {
			setState("off");
		}
	}, [wire]);

	React.useEffect(() => {
		void load();
	}, [load]);

	// While warming, re-poll `/health` so the badge advances to "on"/"failed" without a manual refresh.
	React.useEffect(() => {
		if (state !== "warming") return;
		if (isTabHidden()) return;
		const id = setInterval(() => void load(), EMBED_WARMING_POLL_MS);
		return () => clearInterval(id);
	}, [state, load]);

	const view = state === null ? null : embeddingsView(state);

	const toggle = React.useCallback(async (): Promise<void> => {
		if (view === null) return;
		setBusy(true);
		const want = !view.enabled;
		const ok = await wire.setEmbeddings(want);
		// Optimistically reflect the INTENT (enabling → warming; disabling → off), then re-read the live
		// truth. The warming poll takes it the rest of the way to on/failed.
		if (ok) setState(want ? "warming" : "off");
		setBusy(false);
		void load();
	}, [view, wire, load]);

	const hint =
		state === "warming"
			? "Downloading + loading the local embedding model (~600 MB, one time). Recall is lexical until it is ready."
			: state === "failed"
				? "The embedding model could not load. Recall is lexical (BM25) only. Try toggling off then on, or check the daemon logs."
				: "On runs the local embedding model for semantic search. Off falls back to lexical (BM25) recall only.";

	return (
		<Panel
			title="Embeddings"
			eyebrow="semantic recall · local model"
			right={
				<Badge tone={view?.tone ?? "neutral"} mono dot>
					{view?.label ?? "…"}
				</Badge>
			}
		>
			<div data-testid="embeddings-section" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 6px", flexWrap: "wrap" }}>
				<div style={{ display: "flex", flexDirection: "column", minWidth: 200, flex: 1 }}>
					<span style={{ fontSize: 14, color: "var(--text-primary)" }}>Semantic vector recall</span>
					<span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{hint}</span>
				</div>
				<Button
					variant={view?.enabled ? "secondary" : "primary"}
					size="sm"
					disabled={busy || view === null}
					onClick={() => void toggle()}
					data-testid="embeddings-toggle"
				>
					{busy ? "saving…" : view?.enabled ? "Turn off" : "Turn on"}
				</Button>
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory Formation (dashboard action) — the PROMINENT, provider-gated control that
// turns memory formation on/off. The SIBLING of the embeddings toggle above: it reads
// its state from `wire.health()` `reasons.memory` (`{ enabled, provider }`) and flips it
// through `wire.setMemory(...)` (`POST /api/actions/memory`). UNLIKE embeddings it is NOT
// live — the daemon persists the choice and it takes effect on the NEXT restart, so the
// section says so honestly and (when the portal has a restart action) offers it inline.
// ─────────────────────────────────────────────────────────────────────────────

/** The two provider states the daemon reports for memory formation (mirrors `reasons.memory.provider`). */
type MemoryProvider = "configured" | "unconfigured";

/** The honest memory-formation view derived from `reasons.memory` (or the safe default when absent). */
interface MemoryView {
	/** Whether a model provider is configured — memory formation needs one to run (the gate). */
	readonly provider: MemoryProvider;
	/** The persisted `memory.enabled` preference (what a restart will apply). */
	readonly enabled: boolean;
}

/** The safe default when `/health` omits/malforms `reasons.memory` — unconfigured + off (fail-closed). */
const MEMORY_DEFAULT: MemoryView = { provider: "unconfigured", enabled: false };

/**
 * The PROMINENT, provider-gated Memory Formation control. Mirrors {@link EmbeddingsSection}'s data path
 * exactly — reads the HONEST live state from `wire.health()` (`reasons.memory = { enabled, provider }`,
 * fail-soft to unconfigured/off), flips it through `wire.setMemory(...)` (the `POST /api/actions/memory`
 * sibling of the embeddings action), and RE-READS `health()` after a toggle so the rendered state is the
 * persisted truth, never an optimistic flip.
 *
 * Two states, honestly:
 *   · provider `unconfigured` → a prominent explanatory prompt ("configure a model provider…"), the enable
 *     action HIDDEN (not merely disabled — there is nothing to enable yet), pointing at the Provider keys /
 *     Portkey sections on this same page.
 *   · provider `configured` → the enable control reflecting `enabled`, PLUS the honest "applies on next
 *     daemon restart" note (the toggle is `appliesOnRestart: true`, NOT live) and — when the portal has a
 *     restart action — an inline "Restart now" affordance (mirrors {@link SystemActionsSection}'s restart).
 */
export function MemoryFormationSection({ wire }: { wire: PageProps["wire"] }): React.JSX.Element {
	// `null` while the first health read is in flight (so we never render a wrong default).
	const [view, setView] = React.useState<MemoryView | null>(null);
	const [busy, setBusy] = React.useState(false);
	// True after a successful toggle — surfaces the "restart to apply" affordance (the choice is persisted
	// but not live). Cleared once the daemon restart is kicked off.
	const [pendingRestart, setPendingRestart] = React.useState(false);
	const [restarting, setRestarting] = React.useState(false);

	const load = React.useCallback(async (): Promise<void> => {
		// Fail-soft like the rest of the dashboard: a failed/absent health read degrades to the safe
		// unconfigured/off default rather than throwing into React.
		try {
			const health = await wire.health();
			const mem = health?.reasons?.memory;
			setView(mem ? { provider: mem.provider, enabled: mem.enabled } : MEMORY_DEFAULT);
		} catch {
			setView(MEMORY_DEFAULT);
		}
	}, [wire]);

	React.useEffect(() => {
		void load();
	}, [load]);

	const toggle = React.useCallback(async (): Promise<void> => {
		if (view === null || view.provider !== "configured") return;
		setBusy(true);
		const want = !view.enabled;
		const ok = await wire.setMemory(want);
		setBusy(false);
		if (ok) {
			// The write is persisted but NOT live — surface the restart-to-apply affordance, then re-read
			// the persisted truth (the badge reflects the newly-persisted `enabled`).
			setPendingRestart(true);
		}
		await load();
	}, [view, wire, load]);

	const doRestart = React.useCallback(async (): Promise<void> => {
		setRestarting(true);
		const ok = await wire.restartDaemon();
		// Leave `restarting` true on success — the daemon is going down + coming back; the shell re-hydrates
		// from live endpoints once it answers again. On failure, clear it so the button is usable again.
		if (!ok) setRestarting(false);
		else setPendingRestart(false);
	}, [wire]);

	const configured = view?.provider === "configured";
	const badge = view === null ? { tone: "neutral" as const, label: "…" } : !configured ? { tone: "warning" as const, label: "provider needed" } : view.enabled ? { tone: "verified" as const, label: "on" } : { tone: "neutral" as const, label: "off" };

	return (
		<Panel
			title="Memory Formation"
			eyebrow="turn agent memory on · provider-gated"
			right={
				<Badge tone={badge.tone} mono dot>
					{badge.label}
				</Badge>
			}
			// Prominence: an accented left rail + honey-tinted border so this reads as a real, discoverable
			// feature on the page rather than a buried toggle.
			style={{ borderColor: "var(--honey)", borderLeftWidth: 3, boxShadow: "0 0 0 1px color-mix(in srgb, var(--honey) 22%, transparent)" }}
		>
			<div data-testid="memory-formation" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 2px" }}>
				{/* The lede — always visible, explains the feature so it is discoverable. */}
				<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Let your agents form long-term memory</span>
					<span style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
						Memory formation distills each session into durable, recallable memories so your agents carry context forward across
						conversations. It runs a model provider under the hood, so a provider must be configured before it can be enabled.
					</span>
				</div>

				{view === null ? (
					<div data-testid="memory-loading" style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-tertiary)" }}>loading…</div>
				) : !configured ? (
					/* Provider UNCONFIGURED — a prominent explanatory prompt; the enable action is HIDDEN. */
					<div
						data-testid="memory-unconfigured"
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 8,
							padding: "12px 14px",
							background: "color-mix(in srgb, var(--honey) 8%, transparent)",
							border: "1px solid color-mix(in srgb, var(--honey) 30%, transparent)",
							borderRadius: "var(--radius-md)",
						}}
					>
						<span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Configure a model provider to enable memory formation</span>
						<span style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
							Add a key for Portkey, Anthropic, OpenAI, or OpenRouter in the <strong>Provider keys</strong> (or <strong>Portkey gateway</strong>)
							section on this page, then return here to turn memory formation on.
						</span>
					</div>
				) : (
					/* Provider CONFIGURED — the enable control + the applies-on-restart honesty. */
					<div data-testid="memory-configured" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
						<div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
							<div style={{ display: "flex", flexDirection: "column", minWidth: 200, flex: 1 }}>
								<span style={{ fontSize: 14, color: "var(--text-primary)" }}>Memory formation is {view.enabled ? "on" : "off"}</span>
								<span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
									{view.enabled
										? "New sessions will be distilled into long-term memories."
										: "Sessions are not distilled into long-term memories."}
								</span>
							</div>
							<Button
								variant={view.enabled ? "secondary" : "primary"}
								size="sm"
								disabled={busy}
								onClick={() => void toggle()}
								data-testid="memory-toggle"
							>
								{busy ? "saving…" : view.enabled ? "Turn off" : "Turn on"}
							</Button>
						</div>

						{/* Applies-on-restart honesty — always shown when configured; the toggle is NOT live. */}
						<div
							data-testid="memory-restart-note"
							style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", flexWrap: "wrap" }}
						>
							<span style={{ fontSize: 12, color: "var(--text-secondary)", flex: 1, minWidth: 200 }}>
								This preference is saved immediately, but takes effect on the <strong>next daemon restart</strong>.
								{pendingRestart ? " Restart now to apply your change." : ""}
							</span>
							{restarting ? (
								<span data-testid="memory-restarting" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" }}>restarting…</span>
							) : (
								<Button
									variant={pendingRestart ? "primary" : "secondary"}
									size="sm"
									onClick={() => void doRestart()}
									data-testid="memory-restart-button"
								>
									Restart now
								</Button>
							)}
						</div>
					</div>
				)}
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// System actions (dashboard) — restart the daemon + uninstall (two-step confirm).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The destructive system actions, each gated behind an inline two-step confirm (no new modal
 * dependency). Restart respawns the daemon (the page then waits for `/health` to recover); Uninstall
 * returns the guided removal (detected harnesses + the exact `honeycomb uninstall` command — the
 * daemon does not self-remove the page out from under itself). Both POST through the origin/CSRF +
 * local-mode gated `/api/actions` surface.
 */
export function SystemActionsSection({ wire }: { wire: PageProps["wire"] }): React.JSX.Element {
	const [restartConfirm, setRestartConfirm] = React.useState(false);
	const [restarting, setRestarting] = React.useState(false);
	const [uninstallConfirm, setUninstallConfirm] = React.useState(false);
	const [uninstalling, setUninstalling] = React.useState(false);
	const [uninstallResult, setUninstallResult] = React.useState<UninstallResultWire | null>(null);
	const [uninstallError, setUninstallError] = React.useState(false);

	const doRestart = React.useCallback(async (): Promise<void> => {
		setRestartConfirm(false);
		setRestarting(true);
		const ok = await wire.restartDaemon();
		// Leave `restarting` true on success — the daemon is going down + coming back; the rest of the
		// dashboard re-hydrates from live endpoints once it answers again. On failure, clear it.
		if (!ok) setRestarting(false);
	}, [wire]);

	const doUninstall = React.useCallback(async (): Promise<void> => {
		setUninstallConfirm(false);
		setUninstalling(true);
		setUninstallError(false);
		const result = await wire.uninstall();
		// `uninstall()` returns null on a non-2xx / network failure — surface that honestly rather than
		// silently rendering nothing, so the user knows to retry (the wire contract: null = failed).
		setUninstallResult(result);
		setUninstallError(result === null);
		setUninstalling(false);
	}, [wire]);

	return (
		<Panel title="System" eyebrow="restart · uninstall">
			{/* Restart */}
			<div data-testid="system-restart" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 6px", borderBottom: "1px solid var(--border-subtle)", flexWrap: "wrap" }}>
				<div style={{ display: "flex", flexDirection: "column", minWidth: 200, flex: 1 }}>
					<span style={{ fontSize: 14, color: "var(--text-primary)" }}>Restart the daemon</span>
					<span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Stops and relaunches the background daemon. The dashboard reconnects automatically.</span>
				</div>
				{restarting ? (
					<span data-testid="system-restarting" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" }}>restarting…</span>
				) : restartConfirm ? (
					<div style={{ display: "flex", gap: 8 }}>
						<Button variant="secondary" size="sm" onClick={() => setRestartConfirm(false)}>Cancel</Button>
						<Button variant="danger" size="sm" onClick={() => void doRestart()} data-testid="system-restart-confirm">Confirm restart</Button>
					</div>
				) : (
					<Button variant="secondary" size="sm" onClick={() => setRestartConfirm(true)} data-testid="system-restart-button">Restart</Button>
				)}
			</div>

			{/* Uninstall */}
			<div data-testid="system-uninstall" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 6px" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
					<div style={{ display: "flex", flexDirection: "column", minWidth: 200, flex: 1 }}>
						<span style={{ fontSize: 14, color: "var(--text-primary)" }}>Uninstall Honeycomb</span>
						<span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Reverses Honeycomb's changes to your coding assistants. Your DeepLake login is left intact.</span>
					</div>
					{uninstallConfirm ? (
						<div style={{ display: "flex", gap: 8 }}>
							<Button variant="secondary" size="sm" onClick={() => setUninstallConfirm(false)}>Cancel</Button>
							<Button variant="danger" size="sm" disabled={uninstalling} onClick={() => void doUninstall()} data-testid="system-uninstall-confirm">
								{uninstalling ? "Working…" : "Confirm uninstall"}
							</Button>
						</div>
					) : (
						<Button variant="danger" size="sm" onClick={() => setUninstallConfirm(true)} data-testid="system-uninstall-button">Uninstall</Button>
					)}
				</div>
				{uninstallResult !== null && (
					<div data-testid="system-uninstall-result" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
						<span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{uninstallResult.note}</span>
						{uninstallResult.harnesses.length > 0 && (
							<span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Detected: {uninstallResult.harnesses.join(", ")}</span>
						)}
						<code style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--honey)" }}>{uninstallResult.command}</code>
					</div>
				)}
				{uninstallError && (
					<span data-testid="system-uninstall-error" style={{ fontSize: 12, color: "var(--severity-critical)" }}>
						Could not load uninstall guidance. Retry, or run <code style={{ fontFamily: "var(--font-mono)" }}>honeycomb uninstall</code> in your terminal.
					</span>
				)}
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The routed page.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Settings page (PRD-044). Hydrates the vault settings + secret-name presence over the shared
 * `wire`, and renders the THREE sections: DeepLake auth (044a), provider keys (044b), and search
 * mode + inference (044c). Every setting/secret write goes through the wire with a persist-then
 * re-read contract — the page never trusts a local-only toggle. NO token/secret value crosses into
 * page state, the DOM, a response, or a log line.
 */
export function SettingsPage({ wire }: PageProps): React.JSX.Element {
	const [vault, setVault] = React.useState<VaultSettingsWire>(EMPTY_VAULT_SETTINGS);
	const [secretNames, setSecretNames] = React.useState<readonly string[]>([]);

	// Hydrate the vault settings + the names-only secret presence (both already-served, secret-free).
	const hydrateSettings = React.useCallback(async (): Promise<void> => {
		setVault(await wire.vaultSettings());
	}, [wire]);
	const hydrateSecretNames = React.useCallback(async (): Promise<void> => {
		setSecretNames(await wire.secretNames());
	}, [wire]);

	React.useEffect(() => {
		void hydrateSettings();
		void hydrateSecretNames();
	}, [hydrateSettings, hydrateSecretNames]);

	// Persist one setting then RE-READ so the rendered value is the PERSISTED vault value, never a
	// local-only optimistic toggle (mirrors the dashboard `SettingsPanel` contract). A rejected
	// write (the daemon fail-closes an invalid `recallMode`/model) leaves the persisted value
	// unchanged — the re-read reflects whatever actually persisted.
	const onSaveSetting = React.useCallback(
		async (key: string, value: SettingValueWire): Promise<boolean> => {
			const ok = await wire.setSetting(key, value);
			await hydrateSettings();
			return ok;
		},
		[wire, hydrateSettings],
	);

	// PRD-063a (D-2): derive portkeyEnabled from persisted vault settings so the SearchAndInference
	// section can de-emphasize per-provider rows. The raw value is a SettingValueWire (string|number|
	// boolean|"") coming through the tolerant z.record() catch; coerce to boolean explicitly.
	const portkeyEnabled = vault.settings[SETTING_KEY.portkeyEnabled] === true;

	// PRD-063a (a-AC-4): write the PORTKEY_API_KEY secret then re-read the names-only presence so the
	// badge updates. The value is NEVER stored in component state; it is consumed by the key input,
	// cleared immediately on success, and the only trace of it is the names list confirming presence.
	const onSavePortkeyKey = React.useCallback(
		async (value: string): Promise<boolean> => {
			const ok = await wire.setSecret(PROVIDER_KEY_NAME.portkey, value);
			await hydrateSecretNames();
			return ok;
		},
		[wire, hydrateSecretNames],
	);

	return (
		<PageFrame title="Settings" eyebrow="deeplake · provider keys · search mode">
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
				<DeeplakeAuthSection wire={wire} />
				<ProviderKeysSection wire={wire} secretNames={secretNames} onSaved={() => void hydrateSecretNames()} />
				{/* Dashboard action: turn semantic embeddings on/off (live + persisted). */}
				<EmbeddingsSection wire={wire} />
				{/* Dashboard action: the PROMINENT, provider-gated Memory Formation control (persisted;
				    applies on next daemon restart). Mirrors the embeddings toggle's wire/health seam. */}
				<MemoryFormationSection wire={wire} />
				{/* PRD-063a: Portkey gateway section — toggle, config id, write-only key, fallback toggle. */}
				<PortkeyGatewaySection
					settings={vault.settings}
					secretNames={secretNames}
					onSaveSetting={onSaveSetting}
					onSaveKey={onSavePortkeyKey}
				/>
				<SearchAndInferenceSection
					settings={vault.settings}
					catalog={vault.catalog}
					secretNames={secretNames}
					onSave={onSaveSetting}
					portkeyEnabled={portkeyEnabled}
				/>
				{/* PRD-058d (AC-55d.1.3): the memory.lifecycle.* config reference (symbol · default · effect · env). */}
				<LifecycleConfigSection />
				{/* Dashboard actions: restart the daemon + uninstall (two-step confirm). */}
				<SystemActionsSection wire={wire} />
			</div>
		</PageFrame>
	);
}
