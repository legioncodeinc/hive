# PRD-013a: Post-tenancy guided setup steps

> **Parent:** [`prd-013-guided-onboarding-setup`](./prd-013-guided-onboarding-setup-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

---

## Scope

The three skippable, self-explaining guided steps appended to the end of the onboarding wizard, immediately after the PRD-011 `tenancy` phase persists and before the hard navigation to `/`:

1. **Add an AI API key** — write-only store of a provider key so Nectar/Honeycomb can call a model.
2. **Bind your first project** — point Hive at a folder so capture has somewhere to write.
3. **Turn on memory formation** — enable session→memory distillation (shown only when a key is present).

This sub-PRD owns the new `setup` phase in the `OnboardingScreen` state machine, the three step components, the per-step explainer/skip/continue affordances, the funnel events, and the final handoff to the dashboard. It does **not** own the dashboard checklist (that is [`prd-013b`](./prd-013b-dashboard-setup-checklist.md)).

### Out of scope

- The dashboard completion checklist — [`prd-013b`](./prd-013b-dashboard-setup-checklist.md).
- New daemon endpoints — every write reuses an existing authenticated route.
- Provider/model selection and the Portkey gateway — those stay on the Settings "Search & inference" section.
- Live actuation of memory formation — `setMemory` persists and applies on the next daemon restart.

### Dependencies

- **Blocked by:** hive PRD-011 (the `tenancy` phase and its `completeFlow`/`onComplete` handoff this phase interposes on) — Completed.
- **Reuses:** `wire.setSecret` / `wire.secretNames`, `FolderPicker` / `wire.bindProject`, `wire.setMemory` / `wire.status`, `PROVIDER_KEY_NAME`, the `OnboardingClient.sendEvent` funnel.
- **External:** honeycomb owns `/api/secrets/:name`, `/api/actions/memory`, `/api/status`; nectar owns project binding via the proxied `/api/diagnostics/projects/bind`. Reached same-origin through the gate-exempt `/api/*` proxy leg.

---

## Design

### The new `setup` phase

`OnboardingScreen`'s `Phase` union (`src/dashboard/web/onboarding/onboarding-screen.tsx`) gains a `setup` member. Today the terminal transition is `tenancy` → `handleTenancyComplete` → `window.location.assign("/")`. PRD-013a changes `handleTenancyComplete` to advance to `{ kind: "setup" }` instead of navigating; a new `handleSetupComplete` performs the final `clearSelection()` + navigation to `/` (and honors the existing `onAuthenticated` test seam).

The `setup` phase renders one new component, `SetupSteps`, which owns its own internal sub-step sequence rather than exploding the parent state machine into three phases (keeps the parent diff minimal and the mini-wizard self-contained):

```
SetupSteps(wire, client, onDone)
  substep: "apikey" → "project" → ("memory" iff a provider key is present) → onDone()
```

`SetupSteps` receives the shared `WireClient` (the onboarding screen already builds `wireClient` for the login/tenancy legs) and the `OnboardingClient` (for funnel `sendEvent`). It calls `onDone()` when the last sub-step is completed or skipped.

The tenancy step's completion beacon is unchanged: `completeFlow` still calls `onboardingClient.complete()` (funnel: core onboarding done) before invoking `onComplete`. The setup steps are additive enrichment past that point, and each emits its own event.

### Shared step scaffold

To keep the three steps consistent and satisfy the jscpd duplication gate, a single `StepScaffold` renders the common frame (mirroring the tenancy step's full-screen `shellStyle` and DS tokens): a progress hint ("Step X of Y"), a bold title, a plain-language **what-it-is** paragraph, a **why-it-matters** value line, the step-specific body (`children`), and a footer with a ghost **Skip** button and a primary continue/action button. Copy is beginner-first — no term used without a one-line gloss. The **only** skip affordance is per-step; there is no global "skip all setup" escape (confirmed 2026-07-08), so a beginner sees each step's explainer even when bypassing it (three clicks fully bypasses the flow, and the dashboard checklist recovers anything skipped).

### Step 1 — Add an AI API key

- **What it is (copy intent):** "Hive's memory features (Nectar and Honeycomb) call an AI model to summarize your work, form memories, and rank recall. That needs an API key from a provider."
- **Why it matters (copy intent):** "Without a key, capture still records raw sessions, but nothing gets summarized into durable memories and recall falls back to keyword-only. Adding a key unlocks the memory layer."
- **Body:** a provider selector defaulting to **Anthropic** with a switch to OpenAI / OpenRouter / Cohere (confirmed 2026-07-08), mapped through `PROVIDER_KEY_NAME` (`src/dashboard/web/panels.tsx:463`), a write-only password `Input` (mirroring `ProviderKeyRow` in `src/dashboard/web/pages/settings.tsx`), a "where to get a key" hint link, and a **Save** action calling `wire.setSecret(keyName, value)`.
- **Behavior:** an empty value is rejected client-side before any POST; on a successful save the input is cleared (never echoed) and the step re-reads `wire.secretNames()` to reflect "key set ✓". On save success the step marks a provider key present (gating step 3) — for the wizard's own step-3 gate an in-session successful `setSecret` counts as key-present for immediacy, but the authoritative/durable signal (and the checklist's) is `wire.status().reasons.memory.provider === "configured"` (confirmed 2026-07-08). Continue advances to step 2; Skip advances without saving.
- **Reuse note:** this is the same wire call and presence pattern as the Settings `ProviderKeysSection`; the wizard step is a first-run-shaped presentation of it, not a fork of the daemon surface.

### Step 2 — Bind your first project

- **What it is (copy intent):** "A project is a folder Hive watches. Binding one tells the fleet where to capture from and where memories belong."
- **Why it matters (copy intent):** "Until you bind a folder, every project view is empty and nothing is captured. Point Hive at the repo or folder you want it to remember, and capture starts there."
- **Body:** the reused `FolderPicker` (`src/dashboard/web/folder-picker.tsx`) with `wire` passed through; its `onBound` ack marks the step complete.
- **Behavior:** a successful bind (`wire.bindProject({ path, name })`, `POST /api/diagnostics/projects/bind`) advances the step; a failed bind renders `FolderPicker`'s honest error and does not advance. Skip advances without binding. This mirrors `FirstRunBindCTA`'s bind → route pattern, but advances the wizard instead of routing to the Projects page.

### Step 3 — Turn on memory formation (gated)

- **Gate:** shown only when a provider key is present — either saved in step 1 or already present on entry (`wire.status().reasons.memory.provider === "configured"`, read from honeycomb's `/api/status`, NOT hive's reasons-less `/health`, mirroring `MemoryFormationSection`). When no key exists, `SetupSteps` skips this sub-step entirely and calls `onDone()` after step 2.
- **What it is (copy intent):** "Memory formation distills your captured sessions into durable, searchable memories using the AI key you added."
- **Why it matters (copy intent):** "With it on, your work becomes recallable knowledge instead of raw logs. It's off by default so nothing is summarized until you opt in."
- **Body + behavior:** a primary **Turn on memory formation** action calling `wire.setMemory(true)`; on success the step states honestly that the change applies on the next daemon restart (the ack's `appliesOnRestart: true`). No inline restart in the wizard (confirmed 2026-07-08) — restarting is left to Settings/normal daemon lifecycle so the wizard never bounces its own page mid-flow. Continue/Skip both advance to `onDone()`.

### Funnel events (additive, fire-and-forget)

Mirroring the tenancy step's `onboardingClient.sendEvent` discipline: `setup_shown`, `setup_apikey_saved` / `setup_apikey_skipped`, `setup_project_bound` / `setup_project_skipped`, `setup_memory_enabled` / `setup_memory_skipped`, `setup_completed`. All fire-and-forget; a slow/broken telemetry endpoint never stalls the flow.

---

## User stories

### US-13a.1 — Understand and add a key

**As a** first-run operator who just selected a tenancy, **I want** the wizard to explain what an AI API key is for and let me add one, **so that** Hive's memory features work without me hunting through Settings.

**Acceptance criteria:**
- AC-13a.1.1 Given the tenancy selection has just persisted (`selected: true`), when the flow continues, then the screen renders the setup phase's API-key step (not the dashboard) and fires `setup_shown`.
- AC-13a.1.2 Given the API-key step, when it renders, then it shows a plain-language description of what the key is for and why it matters *before* requesting input, and a visible **Skip** control.
- AC-13a.1.3 Given I enter a key and save, when the save succeeds, then `wire.setSecret(<mapped key name>, <value>)` is called, the input is cleared, presence reflects "key set" via a `secretNames` re-read, and the value is never rendered back.
- AC-13a.1.4 Given I enter an empty value, when I save, then no POST is issued and the step shows a client-side rejection.
- AC-13a.1.5 Given a successful save, when I continue, then `setup_apikey_saved` fires and the flow advances to the project step; given I skip, then `setup_apikey_skipped` fires and the flow advances without a save.

### US-13a.2 — Understand and bind a project

**As a** first-run operator, **I want** the wizard to explain what a project is and let me bind a folder, **so that** capture has somewhere to write from the start.

**Acceptance criteria:**
- AC-13a.2.1 Given the project step, when it renders, then it explains what a project/folder binding is and why it matters, and shows the reused `FolderPicker` and a **Skip** control.
- AC-13a.2.2 Given I pick and bind a folder, when the bind acknowledges success, then `setup_project_bound` fires and the flow advances.
- AC-13a.2.3 Given a bind fails, when the ack reports failure, then the step surfaces `FolderPicker`'s honest error and does **not** advance.
- AC-13a.2.4 Given I skip, when I click Skip, then `setup_project_skipped` fires and the flow advances without binding.

### US-13a.3 — Understand and enable memory (only when a key exists)

**As a** first-run operator who added a key, **I want** the wizard to offer memory formation with an explanation, **so that** I know what it does and can opt in.

**Acceptance criteria:**
- AC-13a.3.1 Given a provider key is present (saved in step 1 or already configured), when the project step completes, then the memory step is shown and explains what memory formation is and why it matters.
- AC-13a.3.2 Given **no** provider key is present, when the project step completes, then the memory step is skipped automatically and the flow proceeds to `onDone()`.
- AC-13a.3.3 Given the memory step, when I turn it on, then `wire.setMemory(true)` is called, the step states the change applies on the next daemon restart, and `setup_memory_enabled` fires.
- AC-13a.3.4 Given the memory step, when I skip, then `setup_memory_skipped` fires and the flow proceeds.

### US-13a.4 — Never be blocked; always land on the dashboard

**As a** first-run operator, **I want** every step to be skippable and the flow to always end at the dashboard, **so that** I am never stuck.

**Acceptance criteria:**
- AC-13a.4.1 Given any setup step, when I skip it, then the flow advances with no side effect and no error.
- AC-13a.4.2 Given the last setup step completes or is skipped, when the flow ends, then `setup_completed` fires, the persisted install selection is cleared, and the browser hard-navigates to `/` (honoring the `onAuthenticated` test seam when injected).
- AC-13a.4.3 Given I refresh or close the tab during any setup step, when I reload `/`, then the server gate serves the dashboard (healthy + authed + tenancy-selected) — the setup steps are additive and never block the gate.

---

## Implementation notes

- **New file:** `src/dashboard/web/onboarding/setup-steps.tsx` — `SetupSteps` + `StepScaffold` + the three step bodies. Mirrors the tenancy step's `shellStyle`, DS tokens, `data-testid` discipline, and fail-soft posture.
- **Edited file:** `src/dashboard/web/onboarding/onboarding-screen.tsx` — add the `setup` phase to the `Phase` union; repoint `handleTenancyComplete` to `setPhase({ kind: "setup" })`; add `handleSetupComplete` (clearSelection + nav/seam); render `<SetupSteps wire={wireClient} client={client} onDone={handleSetupComplete} />` in the `setup` case.
- **Provider key names:** import `PROVIDER_KEY_NAME` from `src/dashboard/web/panels.tsx` (do not re-declare the map).
- **Memory gate read:** use `wire.status()` (`/api/status`, honeycomb reasons), not `wire.health()` (hive liveness has no `memory` reason) — the exact fail-close fix `MemoryFormationSection` documents.
- **Test seams:** `SetupSteps` accepts optional overrides for the initial sub-step and injected clients so the mini-wizard is unit-testable without the network, mirroring `TenancyStep`'s seams.
- **Tests:** `tests/dashboard/onboarding/setup-steps.test.tsx` — each step's explainer renders; save/bind/enable call the right wire method; skip advances without side effects; the memory step is gated on key presence; the final handoff navigates. Add an `onboarding-screen` case for the tenancy→setup→done transition. Follow the `@vitest-environment jsdom` + mocked-wire conventions of `tenancy-step.test.tsx` and `memory-formation-section.test.tsx`.

---

## Decisions

All design questions affecting this sub-PRD were confirmed on 2026-07-08 (see the parent index [Decisions](./prd-013-guided-onboarding-setup-index.md#decisions-confirmed-2026-07-08)): the API-key step defaults to Anthropic with a selector for OpenAI/OpenRouter/Cohere; the memory step states the applies-on-restart honesty as a note with no inline restart; `onboardingClient.complete()` stays at the tenancy step while these steps emit additive `setup_*` events; the steps run in the fixed order **Key → Project → Memory**; the authoritative key-present signal is **`reasons.memory.provider === "configured"`**; and skipping is **per-step only** (no global escape).
