---
ai_description: |
  Operational docs for running hive: the CLI verb surface and day-to-day runbook,
  and the complete on-disk footprint (every file hive reads or writes, its format
  and lifecycle). Ground-truth for an operator or on-call engineer, not a design
  narrative. Write path: library/knowledge/private/operations/<kebab-slug>.md.
human_description: |
  Running hive in practice. CLI verbs, exit codes, where the lock/pid/registry/
  telemetry files live, common failure modes, and the env vars hive reads.
---

# Knowledge: Operations

How to run, inspect, and troubleshoot hive on a real machine. These docs are for the operator and the on-call engineer: the four CLI verbs and what each does, and every path hive touches on disk with its format and lifecycle. The design narrative behind these behaviors lives in `architecture/`; this folder is the practical layer.

## Document index

| Doc | What it covers |
|---|---|
| [cli-and-runbook.md](cli-and-runbook.md) | The four CLI verbs, argv handling, exit codes, env vars, and the day-to-day runbook |
| [on-disk-footprint.md](on-disk-footprint.md) | Every file hive reads/writes: lock, pid, doctor registry entry, telemetry ledger, service units, logs |
