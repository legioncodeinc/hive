---
ai_description: |
  Docs about how hive integrates with the other fleet daemons it consumes over
  loopback: the exact honeycomb / nectar / doctor endpoints, their request/response
  shapes, and the auth pass-through story. hive is a consumer here, not a provider;
  these docs describe contracts hive depends on, not APIs hive owns.
  Write path: library/knowledge/private/integrations/<kebab-slug>.md.
human_description: |
  Fleet integration surfaces. What hive fetches from honeycomb (:3850),
  nectar (:3854), and doctor (:3852), and how the browser's own auth rides through.
---

# Knowledge: Integrations

How hive plugs into the rest of the four-daemon fleet. Hive holds no data of its own; every row it renders comes from a workload daemon's API (proxied server-side) or from doctor's status page and SSE stream. The docs here inventory those upstream endpoints and the transparent auth pass-through that lets the browser's own session reach them without hive becoming an auth authority.

## Document index

| Doc | What it covers |
|---|---|
| [workload-endpoint-inventory.md](workload-endpoint-inventory.md) | Every honeycomb/nectar/doctor endpoint hive consumes, their shapes, and the auth pass-through |
