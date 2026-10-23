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
    category: task_scope # optional: environment | dependencies | user_intent | task_scope | other
    falsifiable: "<concrete probe: command, path, schema version, library linked, …>"
    outcome: pending     # pending | confirmed | broken | untested
    outcome_note: ""     # required at complete — evidence, or why untested/broken
    expires: ""          # default started+14d when blank (YYYY-MM-DD)
  # Example broken (keep as reference; delete if unused):
  # - id: a2
  #   claim: "feature flag defaults off"
  #   confidence: high
  #   category: environment
  #   falsifiable: "grep DEFAULT_FEATURES path | grep flag_name.*False"
  #   outcome: broken
  #   outcome_note: "DEFAULT_FEATURES had flag_name True after merge"
  #   expires: "YYYY-MM-DD"
  # Example untested:
  # - id: a3
  #   claim: "HA entity exists"
  #   confidence: medium
  #   category: environment
  #   falsifiable: "ha state sensor.foo"
  #   outcome: untested
  #   outcome_note: "no HA access from seat this package"
  #   expires: "YYYY-MM-DD"
# Max 7 assumptions. No narrative dumps.
---

# Beliefs

Session-start world model. Leaf-only — never drop this file in `promotion-queue/`.

At package-complete: every assumption gets `confirmed` | `broken` | `untested` **and** a one-line `outcome_note`. Prefer `untested` over a fake `confirmed` when the probe was not run.
