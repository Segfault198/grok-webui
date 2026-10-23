# Leaf Wiki Skill

Owner: Coding agent (per-project instance)
Scope: One project wiki only. No hub awareness, no cross-project reads or writes.
Trigger: On demand during project work, or when a durable pattern emerges worth promoting.

## Load Only What You Need

Do not read reference files until the task demands it. Stop after the relevant file. The routing table below tells you which one to open.

## Routing Table

| Task | Read this file |
|---|---|
| Ingesting raw sources | `references/raw-ingestion.md` |
| Writing or structuring articles | `references/article-writing.md` |
| Signaling promotion to the hub | `references/promotion-signal.md` |
| Link checks or local lint | `references/structural-checks.md` |
| Directory layout or folder questions | `references/directory-layout.md` |
| Session belief files / falsifiable assumptions | `references/beliefs.md` |
| Done-hook checkers (PROMOTE/BELIEF machine gates) | `references/done-hooks.md` |

## Core Rules

- **Ingest:** Drop source material into `raw/` unchanged. Never edit raw files after creation. Name by stable id.
- **Synthesize:** Write articles in `articles/` that contextualize the source — textbook style, cross-referenced, honest about gaps. Cite the raw source by id.
- **Link:** Use dual links: `[[slug]]` plus normal markdown. Bidirectional when it makes sense.
- **Index:** Rebuild `index.md` when stale. It's a derived cache, not source of truth.
- **Log:** Append one line to `log.md`: timestamp, action, target, outcome. Never edit old entries.
- **Promote:** When an article is durable, cross-project relevant, and high confidence, drop a **YAML** manifest (`templates/promotion-manifest.yaml`) into `_meta/promotion-queue/` pointing at an existing `articles/<slug>.md`. Signal only — Tench acts. Milestone notes go in `log.md`, not the queue.

## After a Package (memory hook)

`log.md` ≠ promotion. After meaningful work:

1. **Always:** short append to `log.md`; bump `last_verified` on any article you touched.
2. **M/L:** complete the session belief file (outcomes `confirmed`/`broken`/`untested` + `outcome_note` each; prefer untested/broken over fake confirmed); emit `BELIEF: .wiki/beliefs/<session-id>.md`. See `references/beliefs.md`. SessionInit: read `_meta/calibration.md` warnings if present.
3. **If durable + cross-project:** update or create `articles/<slug>.md`, then queue YAML per `references/promotion-signal.md`. Prefer promote when a related belief was **confirmed** under a falsifiable condition that held.
4. **If leaf-only:** do not invent a promote; say so explicitly (`leaf-only: <reason>`).

**Promote-worthy (examples):** credential/auth seams, capability contracts, provider plugin patterns, RBAC/SCIM, security UX that other projects will copy.  
**Leaf-only (examples):** single-P UI polish, one-off bugfix, roadmap checkbox churn, project-local metrics bumps.

## Article Frontmatter

Every article carries:

```yaml
---
title: ""
summary: ""
tags: []
sources: []          # raw source ids cited
confidence: high|medium|low
last_verified: YYYY-MM-DD
status: current
---
```

`last_verified` and `status` are leaf-local. The hub owns the real freshness contract; the leaf just stamps what it knows.

## What This Skill Does NOT Do

- No hub reads or writes.
- No cross-project awareness.
- No merge, dedup, or archive logic.
- No freshness decay enforcement — that's the hub's job.
- No structural guardian beyond basic link checks on its own articles.

## Directory Layout

```
.wiki/
├── raw/                    # Immutable source material (never edited)
│   └── <source-id>.md
├── articles/               # Synthesized, linked Markdown articles
│   └── <slug>.md
├── beliefs/                # Session beliefs (leaf-only; never promote as YAML)
│   └── <session-id>.md
├── index.md                # Derived cache — rebuilt when stale
├── log.md                  # Append-only operation log
└── _meta/
    ├── promotion-queue/    # Pending YAML manifests for Tench
    └── processed/          # Drained / acknowledged manifests (audit)
```

The `.wiki/` directory is local to the project. It dies with the project. Nothing here is the hub — promote via YAML signal only.
