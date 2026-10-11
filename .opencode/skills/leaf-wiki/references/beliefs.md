# Belief Files

Leaf-only session world-model snapshots under `.wiki/beliefs/`.

## Purpose

- Debugging: see which assumption failed without replaying a transcript
- Handoff: survives compaction (lives outside the chat)
- Promote quality: confirmed assumptions with held falsifiable conditions strengthen `confidence: high` promote decisions

## Rules

1. **Never promote** a belief file as a hub article or queue YAML by itself.
2. **≤7 assumptions** per file. Each has `claim`, `confidence`, `falsifiable`, `outcome`.
3. **Falsifiable must be concrete** — a command, path, schema version, “library X not linked”, broker reject, etc. Ban vague conditions (“if tests pass”, “if it works”).
4. Write the file in **SessionInit after the task is known (M/L)** and **before code edits**. Pure typo S: optional.
5. At package-complete: set each `outcome` to `confirmed` | `broken` | `untested`; one-line `outcome_note` on broken; set `status: complete`.
6. When a belief confirms or breaks a durable article claim, stamp the **article** frontmatter with one line:
   - `belief-confirmed: YYYY-MM-DD`
   - or `belief-broken: YYYY-MM-DD — <short note>`
7. Filename: `.wiki/beliefs/<session_id>.md` (sanitize to `[A-Za-z0-9._-]+`). Template: `templates/belief-file.md`.

## Maintenance

`scripts/maintain-beliefs.py` (deterministic):

- Flags files `stale` when `expires` is past or `status: active` older than 14 days
- Warns on >7 assumptions or vague falsifiable phrases
- Appends `.wiki/log.md` lines; does not call an LLM

Installed via leaf-wiki skill; oc timer runs it across registered leaves (see `deploy/`).
