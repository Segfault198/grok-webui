# Harness (Mark II)

Generated / synced by [coding-agent-mark-ii](https://github.com/Segfault198/coding-agent-mark-ii).

- **Knobs:** edit `overlay.yaml` (models, paths, verify commands, adapters, Plan B).
- **Behavior:** edit Mark II `policy/*.md`, then re-sync — do not hand-edit GENERATED adapters.
- **Re-sync:**

```bash
python3 /path/to/coding-agent-mark-ii/scripts/sync-harness.py \
  --project "$(git rev-parse --show-toplevel)" \
  --overlay .harness/overlay.yaml \
  --target all \
  --install-skills
```
