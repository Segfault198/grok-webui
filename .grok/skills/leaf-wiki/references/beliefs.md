# Belief Files

Leaf-only session world-model snapshots under `.wiki/beliefs/`.

## Purpose

- Debugging: see which assumption failed without replaying a transcript
- Handoff: survives compaction (lives outside the chat)
- Promote quality: confirmed assumptions with held falsifiable conditions strengthen `confidence: high` promote decisions
- Calibration (P2): outcomes feed `.wiki/_meta/calibration.md` hit rates — honesty requires real `broken` / `untested`, not confirm-only

## Rules

1. **Never promote** a belief file as a hub article or queue YAML by itself.
2. **≤7 assumptions** per file. Each has `claim`, `confidence`, `falsifiable`, `outcome`, and **`outcome_note`**.
3. **Falsifiable must be concrete** — a command, path, schema version, “library X not linked”, broker reject, etc. Ban vague conditions (“if tests pass”, “if it works”).
4. Write the file in **SessionInit after the task is known (M/L)** and **before code edits**. Pure typo S: optional.
5. At package-complete: set each `outcome` to `confirmed` | `broken` | `untested`; set `status: complete`.
   - **`outcome_note` required on every outcome** (one line). On `broken`, cite evidence. On `untested`, say why the probe was not run. On `confirmed`, cite what you ran or observed.
   - Prefer **`untested`** when the falsifiable probe was not executed.
   - Prefer **`broken`** when the probe failed — do not stamp `confirmed` to look clean. DONE gates do **not** read `outcome:`.
6. When a belief confirms or breaks a durable article claim, stamp the **article** frontmatter with one line:
   - `belief-confirmed: YYYY-MM-DD`
   - or `belief-broken: YYYY-MM-DD — <short note>`
7. Filename: `.wiki/beliefs/<session_id>.md` (sanitize to `[A-Za-z0-9._-]+`). Template: `templates/belief-file.md`.
8. **`expires`:** default to **started date + 14 days** when omitted (YYYY-MM-DD).
9. **Optional `category`:** `environment` | `dependencies` | `user_intent` | `task_scope` | `other`. Omit rather than guess. Calibration histograms categories only when present.

## Maintenance + calibration

`scripts/maintain-beliefs.py` (deterministic):

- Flags files `stale` when `expires` is past or `status: active` older than 14 days
- Warns on >7 assumptions or vague falsifiable phrases
- Appends `.wiki/log.md` lines; does not call an LLM

`scripts/calibrate-beliefs.py` (P2, deterministic):

- Writes `.wiki/_meta/calibration.md` (counts, outcome rates, all-confirmed streak, empty-expires %, lint tallies, gates)
- `beliefs-daily.sh` runs maintain then calibrate on oc (~07:15 UTC)
- Human counts report: Tench `leaf-beliefs-report.sh` → HA Companion (~07:20 UTC)

`notes=0` from maintain means lint was clean — it is **not** corpus health. Read the calibration report.

Installed via leaf-wiki skill; see `deploy/`.
