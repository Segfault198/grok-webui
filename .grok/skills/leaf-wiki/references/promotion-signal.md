# Promotion Signal

## When to Signal

Signal promotion when an article meets all three:

1. **Durable** — stable knowledge, not a one-off session note.
2. **Cross-project relevant** — useful beyond this leaf.
3. **High confidence** — sourced and verified (`confidence: high` on the article).

### Promote-worthy vs leaf-only

| Promote (article + YAML) | Leaf-only (log / local article, no queue) |
|--------------------------|-------------------------------------------|
| Shared auth/credential seams | One-off CSS / layout polish |
| Capability or plugin contracts other repos will copy | Single-bug fix with no new pattern |
| RBAC/SCIM / security boundaries | Roadmap status checkbox updates |
| Reusable provider integration patterns | Test-count bumps in metrics |

`log.md` can record milestones either way. **Only** the YAML queue graduates knowledge to the hub.

## How to Signal (required)

1. Ensure the durable claims live in an **`articles/<slug>.md`** with valid frontmatter.
2. Drop **one YAML file** in `_meta/promotion-queue/`:
   - Filename: `<YYYY-MM-DD>-<slug>.yaml` (`.yml` ok). **Not** `.md`.
   - Required fields:

```yaml
source: articles/<slug>.md   # must exist in this leaf
topic: <suggested-hub-topic> # suggestion only; Tench routes
reason: <one line — why this graduates>
confidence: high             # must be high for promotion
```

3. Append one `log.md` line: `promote | articles/<slug> | queued <manifest>`.
4. Do not edit the article after signaling; if it changes, drop a **new** manifest.

Template: `templates/promotion-manifest.yaml`.

## What is NOT a promotion manifest

- Milestone / status write-ups (P7 complete, test counts, commit lists) → put in **`log.md`** and/or update the article, then promote the **article**.
- Freeform `.md` files in `promotion-queue/`.
- Manifests whose `source` path does not exist.
- `confidence: medium` or `low` (do not queue; keep working the leaf).

## Transport (Tench-mediated)

- Write the YAML manifest to local `_meta/promotion-queue/` only.
- **Do not** push to `hzr-hub` or add a hub git remote from the leaf.
- Tench fetches pending YAML only from leaves listed in hub `_meta/leaf-projects.yaml` (`enabled: true`).
- **Queueing alone is insufficient** — the leaf must be registered (PA / hub-management `register-leaf` procedure) or fetch will never see the manifest.
- After Tench has drained a manifest, it may be moved to `_meta/processed/` on the leaf (audit); do not delete without a `log.md` line.

## What NOT to Do

- Do not read the hub for duplicates — Tench's job.
- Do not decide final topic placement — suggest only.
- Do not copy the article into the hub — the manifest is the handoff.
- Do not invent hub paths, remotes, or credentials on the leaf.
