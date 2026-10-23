#!/usr/bin/env python3
"""Deterministic belief calibration aggregate (P2).

Usage:
  calibrate-beliefs.py --scan-oc-shared [--home DIR] [--registry YAML]
  calibrate-beliefs.py <project-root> [...]

Writes each leaf `.wiki/_meta/calibration.md`. Prints a machine SUMMARY line.
Exit 1 on hard gates (G3 vague/missing-falsifiable). Soft gates warn only.
No LLM.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from belief_parse import VAGUE, belief_files, parse_frontmatter, scan_shared  # noqa: E402

ACTIVE_WINDOW_ASSUMPTIONS = 10
EMPTY_LEAF_DAYS = 14
CALIBRATION_STALE_DAYS = 7


def _parse_registry(path: Path | None) -> list[dict]:
    """Minimal YAML subset parser for hub leaf-projects.yaml."""
    if path is None or not path.is_file():
        return []
    text = path.read_text(encoding="utf-8")
    leaves: list[dict] = []
    current: dict | None = None
    in_leaves = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if re.match(r"^leaves:\s*$", line):
            in_leaves = True
            continue
        if not in_leaves:
            continue
        if re.match(r"^\s*-\s+name:\s*", line):
            if current:
                leaves.append(current)
            name = line.split(":", 1)[1].strip().strip('"').strip("'")
            current = {"name": name, "enabled": True}
            continue
        if current is None:
            continue
        m = re.match(r"^\s+(enabled|oc_path|hub_topic|notes|beliefs_expected):\s*(.*)$", line)
        if not m:
            if line and not line.startswith(" ") and not line.startswith("#"):
                if current:
                    leaves.append(current)
                current = None
                in_leaves = line.strip() == "leaves:"
            continue
        key, val = m.group(1), m.group(2).strip().strip('"').strip("'")
        if key == "enabled":
            current["enabled"] = val.lower() in ("true", "yes", "1")
        elif key == "beliefs_expected":
            current["beliefs_expected"] = val.lower() in ("true", "yes", "1")
        else:
            current[key] = val
    if current:
        leaves.append(current)
    return leaves


def _lint_file(root_name: str, path: Path, meta: dict) -> list[str]:
    notes: list[str] = []
    assumptions = meta.get("assumptions") or []
    if isinstance(assumptions, list) and len(assumptions) > 7:
        notes.append(f"WARN {root_name}: {path.name} has {len(assumptions)} assumptions (>7)")
    for a in assumptions if isinstance(assumptions, list) else []:
        fals = str(a.get("falsifiable", ""))
        if not fals.strip():
            notes.append(
                f"WARN {root_name}: {path.name} assumption {a.get('id')} missing falsifiable"
            )
        elif VAGUE.search(fals):
            notes.append(
                f"WARN {root_name}: {path.name} assumption {a.get('id')} vague falsifiable"
            )
    return notes


def _all_confirmed_streak(files_meta: list[tuple[Path, dict]]) -> int:
    """Consecutive newest-complete files with zero broken+untested (by started desc)."""
    dated: list[tuple[str, dict]] = []
    for path, meta in files_meta:
        started = str(meta.get("started", ""))[:10]
        if not started:
            started = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).strftime(
                "%Y-%m-%d"
            )
        dated.append((started, meta))
    dated.sort(key=lambda x: x[0], reverse=True)
    streak = 0
    for _, meta in dated:
        if str(meta.get("status", "")).lower() not in ("complete", "completed"):
            break
        outs = [
            str(a.get("outcome", "")).lower()
            for a in (meta.get("assumptions") or [])
            if isinstance(a, dict)
        ]
        if not outs:
            break
        if any(o in ("broken", "untested") for o in outs):
            break
        if all(o == "confirmed" for o in outs):
            streak += 1
        else:
            break
    return streak


def calibrate_project(
    root: Path,
    today: date,
    *,
    empty_expected: bool = False,
) -> dict:
    root = root.resolve()
    name = root.name
    files = belief_files(root)
    lint_notes: list[str] = []
    outcome_c: Counter[str] = Counter()
    agent_c: Counter[str] = Counter()
    cat_c: Counter[str] = Counter()
    empty_expires = 0
    assumps = 0
    files_meta: list[tuple[Path, dict]] = []

    for path in files:
        text = path.read_text(encoding="utf-8")
        meta = parse_frontmatter(text)
        files_meta.append((path, meta))
        lint_notes.extend(_lint_file(name, path, meta))
        agent = str(meta.get("agent", "?")).strip().strip('"') or "?"
        agent_c[agent] += 1
        for a in meta.get("assumptions") or []:
            if not isinstance(a, dict):
                continue
            assumps += 1
            out = str(a.get("outcome", "pending")).lower() or "pending"
            outcome_c[out] += 1
            if not str(a.get("expires", "")).strip():
                empty_expires += 1
            cat = str(a.get("category", "")).strip()
            if cat:
                cat_c[cat] += 1

    confirmed = outcome_c.get("confirmed", 0)
    broken = outcome_c.get("broken", 0)
    untested = outcome_c.get("untested", 0)
    pending = outcome_c.get("pending", 0)
    empty_pct = round(100.0 * empty_expires / assumps, 1) if assumps else 0.0
    streak = _all_confirmed_streak(files_meta)

    warnings: list[str] = []
    gates: dict[str, str] = {
        "G1": "ok",
        "G2": "ok",
        "G3": "ok",
        "G4": "ok",
    }

    # G3 hard: vague / missing falsifiable
    g3 = [n for n in lint_notes if "vague falsifiable" in n or "missing falsifiable" in n]
    if g3:
        gates["G3"] = "hard"
        warnings.extend(g3)

    # G2 soft: all-confirmed window
    if assumps >= ACTIVE_WINDOW_ASSUMPTIONS and (broken + untested) == 0 and confirmed > 0:
        gates["G2"] = "soft"
        warnings.append(
            f"G2 honesty risk: {assumps} assumptions with 0 broken+untested "
            f"(all_confirmed_streak={streak})"
        )

    # G1 empty leaf (caller may mark expected-empty)
    if not files and not empty_expected:
        # days since beliefs dir mtime
        bdir = root / ".wiki" / "beliefs"
        try:
            age = (today - datetime.fromtimestamp(bdir.stat().st_mtime, tz=timezone.utc).date()).days
        except OSError:
            age = EMPTY_LEAF_DAYS
        if age >= EMPTY_LEAF_DAYS:
            gates["G1"] = "soft"
            warnings.append(
                f"G1 empty beliefs dir ≥{EMPTY_LEAF_DAYS}d (age≈{age}d) — no session files"
            )

    # G4: prior calibration stale (if present and we somehow skip write — check before write)
    cal_path = root / ".wiki" / "_meta" / "calibration.md"
    if cal_path.is_file():
        prev = parse_frontmatter(cal_path.read_text(encoding="utf-8"))
        lv = str(prev.get("last_verified", ""))[:10]
        if lv:
            try:
                age = (today - datetime.strptime(lv, "%Y-%m-%d").date()).days
                # Only flag if somehow last_verified already old before this run
                # (timer missed). After we write, it is fresh — reporter uses report mtime.
                if age > CALIBRATION_STALE_DAYS:
                    gates["G4"] = "soft"
                    warnings.append(
                        f"G4 prior calibration last_verified={lv} age={age}d (refreshing now)"
                    )
            except ValueError:
                pass

    now = datetime.now(timezone.utc)
    last_verified = today.isoformat()
    body_lines = [
        "---",
        "title: Belief calibration",
        f"leaf: {name}",
        f"last_verified: {last_verified}",
        f"generated: {now.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "status: current",
        "confidence: medium",
        "---",
        "",
        "# Belief calibration",
        "",
        "Deterministic aggregate from `.wiki/beliefs/`. Leaf-only; never promote this file as an article by itself.",
        "",
        "## Counts",
        "",
        f"- files: {len(files)}",
        f"- assumptions: {assumps}",
        f"- confirmed: {confirmed}",
        f"- broken: {broken}",
        f"- untested: {untested}",
        f"- pending: {pending}",
        f"- empty_expires: {empty_expires}",
        f"- empty_expires_pct: {empty_pct}",
        f"- all_confirmed_streak: {streak}",
        f"- agents: {dict(agent_c) if agent_c else '{}'}",
    ]
    if cat_c:
        body_lines.append(f"- categories: {dict(cat_c)}")
    else:
        body_lines.append("- categories: {}  # optional field; none populated yet")
    body_lines += [
        "",
        "## Maintain lint (this pass)",
        "",
        f"- notes: {len(lint_notes)}",
    ]
    for n in lint_notes:
        body_lines.append(f"- {n}")
    if not lint_notes:
        body_lines.append("- (none)")
    body_lines += ["", "## Warnings", ""]
    if warnings:
        for w in warnings:
            body_lines.append(f"- {w}")
    else:
        body_lines.append("- (none)")
    body_lines += ["", "## Gates", ""]
    for gid in ("G1", "G2", "G3", "G4"):
        body_lines.append(f"- {gid}: {gates[gid]}")
    body_lines.append("")

    meta_dir = root / ".wiki" / "_meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    cal_path.write_text("\n".join(body_lines), encoding="utf-8")

    return {
        "leaf": name,
        "path": str(root),
        "files": len(files),
        "assumptions": assumps,
        "confirmed": confirmed,
        "broken": broken,
        "untested": untested,
        "pending": pending,
        "empty_expires": empty_expires,
        "empty_expires_pct": empty_pct,
        "all_confirmed_streak": streak,
        "agents": dict(agent_c),
        "categories": dict(cat_c),
        "lint_notes": len(lint_notes),
        "warnings": warnings,
        "gates": gates,
        "calibration": str(cal_path),
        "empty": len(files) == 0,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("roots", nargs="*", type=Path)
    ap.add_argument("--scan-oc-shared", action="store_true")
    ap.add_argument("--home", type=Path, default=Path.home())
    ap.add_argument(
        "--registry",
        type=Path,
        default=None,
        help="hub leaf-projects.yaml (enabled leaves; empty-dir G1)",
    )
    ap.add_argument(
        "--state-dir",
        type=Path,
        default=None,
        help="write last-report.json / last-report.txt here",
    )
    args = ap.parse_args()
    today = date.today()

    registry = _parse_registry(args.registry)
    expected_empty = {
        e["name"]
        for e in registry
        if e.get("beliefs_expected") is False
    }
    # Map oc_path basename → registry name
    reg_by_dir: dict[str, dict] = {}
    for e in registry:
        if not e.get("enabled", True):
            continue
        oc_path = e.get("oc_path") or f"shared/projects/{e['name']}"
        reg_by_dir[Path(oc_path).name] = e

    roots: list[Path] = []
    if args.scan_oc_shared:
        roots.extend(scan_shared(args.home))
        # Also include registry leaves whose beliefs dir exists but scan already got them;
        # ensure registry-enabled empty dirs under default path are included
        base = args.home / "shared" / "projects"
        for e in registry:
            if not e.get("enabled", True):
                continue
            oc_path = e.get("oc_path") or f"shared/projects/{e['name']}"
            root = args.home / oc_path if not Path(oc_path).is_absolute() else Path(oc_path)
            if not root.is_absolute():
                # oc_path like shared/projects/foo
                root = args.home / oc_path
            bdir = root / ".wiki" / "beliefs"
            if bdir.is_dir() and root not in roots:
                roots.append(root)
    roots.extend(args.roots)
    # dedupe
    seen: set[Path] = set()
    uniq: list[Path] = []
    for r in roots:
        rr = r.expanduser().resolve()
        if rr not in seen:
            seen.add(rr)
            uniq.append(rr)
    roots = uniq
    if not roots:
        print("no roots", file=sys.stderr)
        return 1

    results: list[dict] = []
    hard = False
    for root in roots:
        entry = reg_by_dir.get(root.name, {})
        empty_expected = root.name in expected_empty or entry.get("beliefs_expected") is False
        # Idle registered leaf with no product work: still warn (G1), unless beliefs_expected false
        rec = calibrate_project(root, today, empty_expected=empty_expected)
        results.append(rec)
        print(f"calibrated {root} files={rec['files']} assumptions={rec['assumptions']}")
        for w in rec["warnings"]:
            print(f"  WARN {w}")
        if rec["gates"].get("G3") == "hard":
            hard = True

    # Swarm rollup for empty enabled registry leaves that have beliefs dirs
    swarm = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "leaves": len(results),
        "files": sum(r["files"] for r in results),
        "assumptions": sum(r["assumptions"] for r in results),
        "confirmed": sum(r["confirmed"] for r in results),
        "broken": sum(r["broken"] for r in results),
        "untested": sum(r["untested"] for r in results),
        "empty_leaves": [r["leaf"] for r in results if r["empty"]],
        "g1": [r["leaf"] for r in results if r["gates"].get("G1") != "ok"],
        "g2": [r["leaf"] for r in results if r["gates"].get("G2") != "ok"],
        "g3": [r["leaf"] for r in results if r["gates"].get("G3") != "ok"],
        "hard": hard,
        "per_leaf": results,
    }

    # Machine line for reporters
    summary = (
        f"SUMMARY leaves={swarm['leaves']} files={swarm['files']} "
        f"assumptions={swarm['assumptions']} confirmed={swarm['confirmed']} "
        f"broken={swarm['broken']} untested={swarm['untested']} "
        f"empty={','.join(swarm['empty_leaves']) or '-'} "
        f"G1={','.join(swarm['g1']) or '-'} "
        f"G2={','.join(swarm['g2']) or '-'} "
        f"G3={','.join(swarm['g3']) or '-'} "
        f"hard={'1' if hard else '0'}"
    )
    print(summary)

    state_dir = args.state_dir
    if state_dir is None:
        state_dir = Path.home() / ".local/share/hzr-skills/leaf-wiki/state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "last-report.json").write_text(
        json.dumps(swarm, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    # Human-glance text
    lines = [
        f"Belief calibration {swarm['generated']}",
        f"leaves={swarm['leaves']} files={swarm['files']} assumptions={swarm['assumptions']}",
        f"confirmed={swarm['confirmed']} broken={swarm['broken']} untested={swarm['untested']}",
        f"empty={', '.join(swarm['empty_leaves']) or '(none)'}",
        f"G1={', '.join(swarm['g1']) or 'ok'} G2={', '.join(swarm['g2']) or 'ok'} "
        f"G3={', '.join(swarm['g3']) or 'ok'}",
        f"hard={'yes' if hard else 'no'}",
        summary,
    ]
    (state_dir / "last-report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    return 1 if hard else 0


if __name__ == "__main__":
    raise SystemExit(main())
