#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared helpers for zkz tooling across multiple project copies."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

# This toolkit root (…/zkz)
ZKZ_ROOT = Path(__file__).resolve().parent

# Source of shared Cursor rules/skills
MALL_ROOT = Path(r"E:\work\mall")


def resolve_w1_utf8_pair(path: str | Path | None = None) -> dict:
    """W1/*U pair via scripts/lib/resolve_w1_utf8_pair.py (shared with zkz-sandbox)."""
    import importlib.util

    mod_path = ZKZ_ROOT / "scripts" / "lib" / "resolve_w1_utf8_pair.py"
    spec = importlib.util.spec_from_file_location("resolve_w1_utf8_pair", mod_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {mod_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    p = Path(path) if path else None
    return mod.resolve_pair(explicit=p)


def _is_project_root(path: Path) -> bool:
    if not path.is_dir():
        return False
    if (path / ".git").exists():
        return True
    if (path / "Project" / "MDK-ARM(uV4)").is_dir():
        return True
    if (path / "User").is_dir() and (path / "Project").is_dir():
        return True
    return False


def _git_toplevel(cwd: Path) -> Path | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    text = (result.stdout or "").strip()
    if not text:
        return None
    path = Path(text)
    return path if _is_project_root(path) else None


def resolve_project_root(script_file: str | Path, parents: int) -> Path:
    """Resolve project root for multiple repo copies.

    Prefer the classic relative layout:
      <project>/zkz/scripts/xxx.py           -> parents=2
      <project>/zkz/scripts/fileTran/xxx.py  -> parents=4

    When zkz is shared (e.g. Desktop/zkz), relative parents may not point to a
    project; then use argv[1] / B01_PROJECT_ROOT / git toplevel / cwd walk.
    """
    script_path = Path(script_file).resolve()
    candidate = script_path
    for _ in range(parents):
        candidate = candidate.parent

    if _is_project_root(candidate):
        return candidate

    if len(sys.argv) > 1 and sys.argv[1] and not sys.argv[1].startswith("-"):
        arg = Path(sys.argv[1]).expanduser().resolve()
        if _is_project_root(arg):
            return arg

    env = os.environ.get("B01_PROJECT_ROOT", "").strip()
    if env:
        env_path = Path(env).expanduser().resolve()
        if _is_project_root(env_path):
            return env_path

    cwd = Path.cwd().resolve()
    git_root = _git_toplevel(cwd)
    if git_root is not None:
        return git_root

    cur = cwd
    for _ in range(8):
        if _is_project_root(cur):
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent

    # Keep classic parent.parent result even if detection failed
    return candidate
