# Structural Checks (Leaf-Local)

Run after writes to this leaf only. No hub awareness.

- Every article has required frontmatter: title, summary, tags, sources, confidence, last_verified, status.
- Every `[[slug]]` link resolves to an existing article in this leaf.
- No orphan articles — every article is linked from at least one other, or from `index.md`.
- `index.md` lists every article. Rebuild when stale.
- `log.md` has an entry for every operation.

Failures are reported, not auto-fixed. The agent fixes and re-runs.
