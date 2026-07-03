---
ai_description: |
  Docs about hive's outbound telemetry: the single egress chokepoint (src/telemetry/emit.ts),
  the four lifecycle events, the closed property allow-list, the opt-out gates, the dedupe
  ledger, and the bounded fire-and-forget POST. This domain is about hive SENDING telemetry
  out, distinct from the fleet-TELEMETRY it consumes from doctor (that is frontend/ + integrations/).
  Write path: library/knowledge/private/telemetry/<kebab-slug>.md.
human_description: |
  Hive's outbound telemetry. The one chokepoint that can POST to PostHog, what it sends,
  what it cannot send, and how a user opts out. Not to be confused with the doctor
  fleet-telemetry hive relays to the browser.
---

# Knowledge: Telemetry

Hive's outbound (egress) telemetry. Every outbound-to-internet call hive can make funnels through one module, and this folder documents it: the four lifecycle events, the closed five-key property allow-list, the opt-out gates, the dedupe ledger, and the bounded POST. This is distinct from the fleet-telemetry hive relays from doctor to the browser; that inbound stream is covered in `frontend/fleet-telemetry-client.md` and `integrations/`.

## Document index

| Doc | What it covers |
|---|---|
| [telemetry-egress.md](telemetry-egress.md) | The single egress chokepoint, the four events, scrubbing, opt-outs, and the dedupe ledger |
