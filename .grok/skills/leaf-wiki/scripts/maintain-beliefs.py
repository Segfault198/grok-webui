#!/usr/bin/env python3
"""Deterministic belief-file maintenance for leaf wikis (P1).

Usage:
  maintain-beliefs.py <project-root> [<project-root> ...]
  maintain-beliefs.py --scan-oc-shared

Flags stale beliefs, warns on oversize / vague falsifiable text,
appends .wiki/log.md. No LLM.
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from belief_parse import VAGUE, parse_frontmatter, scan_shared  # noqa: E402

ACTIVE_MAX_DAYS = 14


def dump_status(text: str, new_status: str) -> str:
    if re.search(r"^status:\s*.*$", text, re.M):
        return re.sub(r"^status:\s*.*$", f"status: {new_status}", text, count=1, flags=re.M)
    if text.startswith("---\n"):
        return text.replace("---\n", f"---\nstatus: {new_status}\n", 1)
    return text


def maintain_project(root: Path, today: date) -> list[str]:
    wiki = root / ".wiki"
    beliefs_dir = wiki / "beliefs"
    log_path = wiki / "log.md"
    notes: list[str] = []
    if not beliefs_dir.is_dir():
        return notes

    for path in sorted(beliefs_dir.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        meta = parse_frontmatter(text)
        changed = False
        status = str(meta.get("status", "active"))
        assumptions = meta.get("assumptions") or []
        if isinstance(assumptions, list) and len(assumptions) > 7:
            notes.append(f"WARN {root.name}: {path.name} has {len(assumptions)} assumptions (>7)")
        for a in assumptions if isinstance(assumptions, list) else []:
            fals = str(a.get("falsifiable", ""))
            if not fals.strip():
                notes.append(
                    f"WARN {root.name}: {path.name} assumption {a.get('id')} missing falsifiable"
                )
            elif VAGUE.search(fals):
                notes.append(
                    f"WARN {root.name}: {path.name} assumption {a.get('id')} vague falsifiable"
                )
            exp = str(a.get("expires", "")).strip()
            if exp:
                try:
                    ed = datetime.strptime(exp[:10], "%Y-%m-%d").date()
                    if ed < today and status != "stale":
                        text = dump_status(text, "stale")
                        status = "stale"
                        changed = True
                        notes.append(
                            f"STALE {root.name}: {path.name} expired assumption {a.get('id')} on {exp}"
                        )
                except ValueError:
                    notes.append(f"WARN {root.name}: {path.name} bad expires={exp}")

        started = str(meta.get("started", ""))[:10]
        if status == "active" and started:
            try:
                sd = datetime.strptime(started, "%Y-%m-%d").date()
                if (today - sd).days > ACTIVE_MAX_DAYS:
                    text = dump_status(text, "stale")
                    changed = True
                    notes.append(f"STALE {root.name}: {path.name} active >{ACTIVE_MAX_DAYS}d")
            except ValueError:
                pass

        if changed:
            path.write_text(text, encoding="utf-8")
            if log_path.parent.is_dir():
                line = (
                    f"- {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}: "
                    f"beliefs | maintain | {path.name} → stale\n"
                )
                with log_path.open("a", encoding="utf-8") as fh:
                    fh.write(line)
    return notes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("roots", nargs="*", type=Path)
    ap.add_argument("--scan-oc-shared", action="store_true")
    ap.add_argument("--home", type=Path, default=Path.home())
    args = ap.parse_args()
    today = date.today()
    roots: list[Path] = []
    if args.scan_oc_shared:
        roots.extend(scan_shared(args.home))
    roots.extend(args.roots)
    if not roots:
        print("no roots", file=sys.stderr)
        return 1
    all_notes: list[str] = []
    for root in roots:
        root = root.expanduser().resolve()
        all_notes.extend(maintain_project(root, today))
        print(f"scanned {root}")
    for n in all_notes:
        print(n)
    print(f"done projects={len(roots)} notes={len(all_notes)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
