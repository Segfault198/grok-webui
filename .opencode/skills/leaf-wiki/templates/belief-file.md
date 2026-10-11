---
session_id: "<session-or-prompt-id>"
agent: "grok"   # grok | opencode | copilot | codex | claude
started: "YYYY-MM-DDTHH:MM:SSZ"
task: "<one-line task>"
status: active   # active | complete | stale
assumptions:
  - id: a1
    claim: "<short falsifiable claim>"
    confidence: medium   # high | medium | low
    falsifiable: "<concrete probe: command, path, schema version, library linked, …>"
    outcome: pending     # pending | confirmed | broken | untested
    outcome_note: ""
    expires: ""          # optional YYYY-MM-DD
# Max 7 assumptions. No narrative dumps.
---

# Beliefs

Session-start world model. Leaf-only — never drop this file in `promotion-queue/`.
