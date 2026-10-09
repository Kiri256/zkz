#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理真源 Project 里的本机垃圾，不动工程文件和编烧产物。

保留：uvproj/uvopt、sct、YTSwarm、compile_commands、output.hex/axf、J-Link 脚本。
删除：uvgui、编译中间文件、List、日志、.cache。

不清理 .zkz/keil-native（那边是正在编的中间文件）。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ZKZ_ROOT = Path(__file__).resolve().parents[1]
if str(ZKZ_ROOT) not in sys.path:
    sys.path.insert(0, str(ZKZ_ROOT))

from project_paths import resolve_project_root  # noqa: E402

KEEP_OBJ_NAMES = {"output.hex", "output.axf", "output.sct"}
OBJ_JUNK_EXT = {".o", ".d", ".dep", ".htm", ".lnp", ".iex", ".bak"}
MDK_JUNK_PREFIXES = (
    "build_output.txt",
    "flash_output",
    "pinreset_output",
    "jlinklog.txt",
)
MDK_JUNK_CONTAINS = ("uvgui",)


def is_mdk_junk_file(name: str) -> bool:
    low = name.lower()
    if low.endswith(".saved_uv4"):
        return True
    if any(low.startswith(p) for p in MDK_JUNK_PREFIXES):
        return True
    if any(p in low for p in MDK_JUNK_CONTAINS):
        return True
    return False


def iter_mdk_roots(project: Path) -> list[Path]:
    out = []
    f429 = project / "Project" / "MDK-ARM(uV4)"
    if f429.is_dir():
        out.append(f429)
    h750 = project / "H750" / "Projects" / "MDK-ARM"
    if h750.is_dir():
        out.append(h750)
    return out


def remove_path(path: Path, dry: bool, removed: list[str]) -> None:
    rel = str(path)
    if dry:
        removed.append(rel)
        return
    if path.is_dir():
        for child in path.iterdir():
            remove_path(child, dry, removed)
        try:
            path.rmdir()
            removed.append(rel + "/")
        except OSError:
            pass
        return
    try:
        path.unlink()
        removed.append(rel)
    except OSError as e:
        print("skip %s (%s)" % (path, e))


def clean_mdk(mdk: Path, dry: bool) -> list[str]:
    removed = []
    for p in mdk.iterdir():
        if p.is_file() and is_mdk_junk_file(p.name):
            remove_path(p, dry, removed)
    cache = mdk / ".cache"
    if cache.is_dir():
        remove_path(cache, dry, removed)

    obj = mdk / "Flash" / "Obj"
    if obj.is_dir():
        for p in obj.iterdir():
            if not p.is_file():
                continue
            ext = p.suffix.lower()
            if ext in OBJ_JUNK_EXT:
                remove_path(p, dry, removed)
            elif ext in {".hex", ".axf"} and p.name.lower() not in KEEP_OBJ_NAMES:
                remove_path(p, dry, removed)

    listing = mdk / "Flash" / "List"
    if listing.is_dir():
        for p in listing.iterdir():
            if p.is_file():
                remove_path(p, dry, removed)
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description="清理真源 Project 本机垃圾")
    parser.add_argument("project", nargs="?", help="真源工程根目录")
    parser.add_argument("-n", "--dry-run", action="store_true", help="只列出，不删除")
    args = parser.parse_args()

    if args.project:
        root = Path(args.project).expanduser().resolve()
    else:
        # parents=2：<project>/zkz/scripts/xxx.py；桌面共享 zkz 时走 argv/环境/cwd
        root = resolve_project_root(__file__, 2)

    mdks = iter_mdk_roots(root)
    if not mdks:
        print("未找到 Project/MDK-ARM(uV4) 或 H750/Projects/MDK-ARM: %s" % root)
        return 1

    print("project: %s%s" % (root, " (dry-run)" if args.dry_run else ""))
    all_removed = []
    for mdk in mdks:
        print("mdk: %s" % mdk)
        all_removed.extend(clean_mdk(mdk, args.dry_run))

    print("removed %d items" % len(all_removed))
    if args.dry_run and all_removed:
        for p in all_removed[:30]:
            print("  " + p)
        if len(all_removed) > 30:
            print("  ... %d more" % (len(all_removed) - 30))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
