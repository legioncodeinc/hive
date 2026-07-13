# Changelog

## v0.11.1 — 2026-07-13

Fixed search-result badges so hits from the live daemon correctly display their memory type (e.g. 'gotcha') instead of always falling back to 'fact'.

## v0.11.0 — 2026-07-13

The dashboard's Add Memory form now includes an explicit destination-project selector (defaulting to the currently viewed project, with Inbox always available) so new memories are filed exactly where you intend.

## v0.10.1 — 2026-07-12

Search results in the dashboard's memory browser now render as the same interactive, clickable cards as the browse list, complete with relevance score and working edit/forget actions, instead of a separate inert display.

## v0.10.0 — 2026-07-12

The Memory Graph dashboard page now explains why the graph is empty (persistence off, no entities extracted yet, or a query error) and lets you enable graph persistence directly from the page, plus a new Memory graph toggle in Settings.

## v0.9.0 — 2026-07-12

Dashboard health chips now honestly surface new daemon states (Portkey no_model/unreachable status, embeddings suspect/unknown) and memory-formation counters, and the memory-formation toggle shows an accurate 'applied live', 'restart required', or 'failed' message based on the daemon's response.

## v0.8.1 — 2026-07-12

The Settings dashboard now proactively warns when no model is set before enabling the Portkey gateway and clearly surfaces the daemon's rejection if you try to enable it anyway.

## v0.8.0 — 2026-07-12

Adds a live 'Tokens injected' KPI tile on the dashboard (with the corpus estimate kept as a subordinate caption) and a disclosed partial-net view on the ROI page for daemons that compute a net ROI with some cost inputs missing. Both additions are backward-compatible with older daemon payloads.

## v0.7.1 — 2026-07-12

Fixes several dashboard UI issues: honest below-threshold pollinate messaging, recall scores now shown at real precision instead of always rounding to 0.00, the sidebar project list refreshing right after binding a project, and consolidation of live-log tails onto the Logs page.

## v0.7.0 — 2026-07-08

Adds a new onboarding step to connect Claude Code and a dashboard harness-status card showing per-harness connection health with a repair/reconnect action, plus hardening of the underlying harness CLI integration against invalid input.


## v0.6.9 — 2026-07-08

Release accumulated changes since the last version.

