# Done hooks (machine gates)

Coding seats must end M/L packages (and contract-changing S) with:

- `BELIEF: .wiki/beliefs/<id>.md` (file exists; outcomes complete)
- Exactly one of: `PROMOTE queued: …` | `PROMOTE skipped: leaf-only — …`

## Plain-text signal lines

Emit each signal as its own plain text line.

- Forbidden: markdown bold/italics around keywords (e.g. `**PROMOTE skipped:**`); do not wrap the whole signal in backticks.
- Watchers do **not** strip markdown decoration.
- Checker SoT remains Mark II (`package-complete.md`, `docs/HOOKS.md`, `require_*.sh`) — this skill is a pointer only.

## Machine checkers (SoT)

**Source of truth:** [coding-agent-mark-ii](https://github.com/Segfault198/coding-agent-mark-ii)  
`scripts/require_promote_line.sh` and `scripts/require_belief_file.sh`.

Orchestrators (Tench oc-handoff) install **copies** into  
`~/.grok/long-running-background-tasks/lib/` from a Mark II pin.  
Hub may keep mirrors under `hub/scripts/` — do not fork logic into this skill.

Belief **templates** and promote **YAML** shape stay in this skill (`templates/`, `references/beliefs.md`, `references/promotion-signal.md`).
