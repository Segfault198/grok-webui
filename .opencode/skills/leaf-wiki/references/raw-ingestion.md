# Raw Ingestion

## Rules

- Every source lands in `raw/` as an immutable file. Name it by a stable id: `<source-id>.md`.
- Never edit a raw file after creation. If the source changes, create a new raw file with a new id and cite both.
- Raw files are evidence, not articles. They are not linked, not indexed, not synthesized.
- If a source is large, split it into multiple raw files by logical chunk. Each gets its own id.
