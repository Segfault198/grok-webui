#!/usr/bin/env python3
"""Shared belief frontmatter parser for maintain/calibrate (no LLM)."""
from __future__ import annotations

import re
from pathlib import Path

VAGUE = re.compile(
    r"\b(if tests? pass|if it works|hopefully|should be fine|when ready|etc\.?)\b",
    re.I,
)


def parse_frontmatter(text: str) -> dict:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}
    meta: dict = {}
    current_assump = None
    assumptions: list[dict] = []
    for raw in text[4:end].splitlines():
        if raw.startswith("  - id:") or raw.startswith("  -id:"):
            if current_assump:
                assumptions.append(current_assump)
            current_assump = {"id": raw.split(":", 1)[1].strip().strip('"').strip("'")}
            continue
        if current_assump is not None and raw.startswith("    "):
            line = raw.strip()
            if ":" in line:
                k, v = line.split(":", 1)
                current_assump[k.strip()] = v.strip().strip('"').strip("'")
            continue
        if current_assump is not None and not raw.startswith(" "):
            assumptions.append(current_assump)
            current_assump = None
        if ":" in raw and not raw.startswith(" "):
            k, v = raw.split(":", 1)
            meta[k.strip()] = v.strip().strip('"').strip("'")
    if current_assump:
        assumptions.append(current_assump)
    if assumptions:
        meta["assumptions"] = assumptions
    return meta


def scan_shared(home: Path) -> list[Path]:
    base = home / "shared" / "projects"
    if not base.is_dir():
        return []
    return sorted(p for p in base.iterdir() if (p / ".wiki" / "beliefs").is_dir())


def belief_files(root: Path) -> list[Path]:
    beliefs = root / ".wiki" / "beliefs"
    if not beliefs.is_dir():
        return []
    return sorted(p for p in beliefs.glob("*.md") if p.is_file())
