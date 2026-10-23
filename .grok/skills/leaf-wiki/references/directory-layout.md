# Directory Layout Reference

The leaf wiki lives at `.wiki/` in the project root.

```
.wiki/
├── raw/                    # Immutable source material (never edited)
│   └── <source-id>.md
├── articles/               # Synthesized, linked Markdown articles
│   └── <slug>.md
├── beliefs/                # Session belief files (leaf-only; never promote)
│   └── <session-id>.md
├── index.md                # Derived cache — rebuilt when stale
├── log.md                  # Append-only operation log
├── config.yaml             # Optional path persistence (written at init)
└── _meta/
    ├── promotion-queue/    # Pending manifests for Tench (YAML only)
    ├── processed/          # Drained / acknowledged manifests (audit)
    └── calibration.md      # P2 hit-rate stub (deterministic; calibrate-beliefs.py)
```

## Conventions

- `raw/` is immutable after create. Never edit; add a new source id if content changes.
- `articles/` cite raw ids in frontmatter `sources:`.
- `index.md` is derived — regenerate when articles change; do not treat it as source of truth.
- `log.md` is append-only. Never edit old entries.
- `beliefs/` is leaf-only session scratch; never queue belief files for hub promote. See `beliefs.md`.
- `_meta/calibration.md` is written by `calibrate-beliefs.py` (counts + gates). SessionInit reads warnings from it. Do not hand-edit as SoT — regenerate via calibrate.
- No hub paths, no cross-project peeks. Promotion is a local manifest drop only.

## Processed queue

After Tench drains a promotion (or explicitly acknowledges it), move the YAML from `promotion-queue/` to `processed/` and append a `log.md` line. Do not delete without logging.
