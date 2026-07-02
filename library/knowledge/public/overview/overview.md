# Hive Overview

> Category: Overview | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

Read this if you have an Apiary install and want to know what hive is, what you will see at `localhost:3853`, and why there is only one address to remember.

**Related:**
- [../../private/architecture/system-overview.md](../../private/architecture/system-overview.md) (internal deep dive)
---

## One dashboard for your whole Apiary install

The Apiary runs several services on your machine: Honeycomb doing the memory work, Nectar mapping your sources, Doctor watching all of them. Each one has its own port, and none of that should be your problem. Hive is the front door: one always-on portal at **`http://127.0.0.1:3853`** that serves the entire dashboard for everything behind it. Bookmark that one address and you are done. No port hunting, no "which service serves that page," no juggling tabs across loopback ports.

Hive was designed by Mario Aldayuz around a simple observation: the old dashboard lived inside the memory service, so it went dark exactly when you needed a status view most. So the portal became its own service, built to be the last thing standing.

## What you see when you open it

**On a normal day: the dashboard.** The root page is the full Apiary dashboard: your memories, projects, the memory graph, the hive graph, sync activity, logs, ROI, and settings, all in one place. A health rail sits at the top of every page with a live pill per service, so you always know the state of the fleet without leaving what you are doing. Click through to the Health page for per-service metrics, Deep Lake connection status, and a live log tail with adjustable verbosity.

**On a cold boot: the buzzing screen.** If you open the portal while the services are still waking up, you get an honest readiness screen at `/buzzing`: one tile per service, each with a little bee icon showing its state, from an empty honeycomb cell (starting) to a bee in full flight (active). The moment the fleet is ready, you land on the dashboard automatically. You will never see a broken page or a false "first time setup" screen just because something was still booting.

**Not signed in yet: the login screen.** If the fleet is healthy but you have not connected your credentials, you get the guided device-flow setup at `/login`. Health is checked first, on purpose: if nothing behind the portal will answer, prompting you to log in would be pointless.

## Always on, by design

Hive starts when your machine boots, restarts itself if it ever crashes, and is watched by Doctor like every other Apiary service. It binds only to your machine (`127.0.0.1`), so nothing off your device can reach it. Your browser talks to hive alone; hive's server fetches everything else over local loopback on your behalf and passes your session straight through without storing anything. If one service goes down, its panels say "unreachable" while the rest of the dashboard keeps working, and everything recovers on its own when Doctor brings the service back.

## Reading the bee icons

Every service tile on the buzzing screen and every pill in the health rail uses the same five states, drawn as distinct shapes so they read even without color:

| Icon | State | What it means |
|---|---|---|
| Empty honeycomb cell (dashed) | starting | Registered, but has not checked in yet |
| Bee with half-folded wings | warming | Just came up healthy; settling in |
| Bee with wide-spread wings | active | Checked in and healthy |
| One-winged bee with a caution mark | degraded | Up, but not fully healthy |
| Bee on its back, wings crossed | error | Failed or unreachable; likely needs attention |

## Quick answers

**Why does the address start with 127.0.0.1?** That is your own machine. The portal binds locally only; nothing outside your device can reach it, and no account or cloud login is needed to view it.

**A panel says "unreachable." Is my data gone?** No. It means the service that owns that panel is not answering right now. Doctor restarts crashed services automatically; the panel recovers on its own once the service is back. The Health page shows exactly which service and since when.

**The whole page went to the buzzing screen. Now what?** Wait a moment. The buzzing screen means the fleet is not fully healthy, and it dismisses itself the moment it is. If a tile stays on the error bee, that service needs attention; the Health page's live logs are the first place to look.

**Does hive store my credentials?** No. Hive passes your session through to the services that own your data and stores nothing itself. Signing in (the device flow at `/login`) creates your Deep Lake credential on your machine, managed by Honeycomb, not by the portal.

## You should rarely need the terminal

The Apiary installer sets all of this up. For completeness, the CLI is four commands:

```bash
hive start                # run the portal (the default)
hive install-service      # install the boot-time OS service
hive uninstall-service    # remove the OS service
hive register             # register hive with Doctor's supervisor
```

Day to day, the only thing you touch is the browser: `http://127.0.0.1:3853`.
