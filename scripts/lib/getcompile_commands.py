#!/usr/bin/env python3
"""Generate compile_commands.json in the current project root via YTSwarm."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

CLANGD_COMPILER = "clang"


def _norm(p: Path) -> str:
    return str(p).replace("/", "\\")


def resolve_keil_layout(project_root: Path) -> dict:
    project_root = Path(project_root).resolve()
    name = project_root.name.lower()
    h750 = project_root / "H750" / "Projects" / "MDK-ARM" / "H750_N.uvprojx"
    if "h750" in name and h750.is_file():
        mdk = h750.parent
        yt = project_root / "Project" / "MDK-ARM(uV4)" / "YTSwarm.exe"
        if not yt.is_file():
            yt = mdk / "YTSwarm.exe"
        return {
            "flavor": "h750",
            "mdk": mdk,
            "uvproj": "H750_N.uvprojx",
            "ytswarm": yt,
        }
    mdk = project_root / "Project" / "MDK-ARM(uV4)"
    uvproj = "b_01.uvproj"
    if not (mdk / uvproj).is_file():
        uvproj = "b_01.uvprojx"
    return {
        "flavor": "f429",
        "mdk": mdk,
        "uvproj": uvproj,
        "ytswarm": mdk / "YTSwarm.exe",
    }


def absolutize_entries(entries: list, mdk: Path) -> list:
    mdk = Path(mdk).resolve()
    fixed = []
    for entry in entries:
        file_path = entry.get("file", "")
        if str(file_path).lower().endswith(".s"):
            continue

        args = list(entry.get("arguments", []))
        if args and args[0] == "<compilerPath>":
            args[0] = CLANGD_COMPILER

        new_args = []
        for a in args:
            if a.startswith("-I") and len(a) > 2:
                inc = a[2:].strip('"')
                if os.path.isabs(inc):
                    ap = Path(os.path.normpath(inc))
                else:
                    ap = Path(os.path.normpath(str(mdk / inc)))
                new_args.append("-I" + _norm(ap))
            else:
                new_args.append(a)

        if os.path.isabs(file_path):
            fp = Path(os.path.normpath(file_path))
        else:
            fp = Path(os.path.normpath(str(mdk / file_path)))

        entry["directory"] = _norm(mdk)
        entry["file"] = _norm(fp)
        if new_args:
            last = new_args[-1].strip('"')
            if last.endswith(".c") or last.endswith(".cpp") or last.endswith(".cc"):
                new_args[-1] = _norm(fp)
        entry["arguments"] = new_args
        fixed.append(entry)
    return fixed


def main() -> int:
    if len(sys.argv) >= 2:
        project_root = Path(sys.argv[1]).resolve()
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
        from project_paths import resolve_project_root
        project_root = resolve_project_root(__file__, parents=3)

    layout = resolve_keil_layout(project_root)
    mdk_dir = layout["mdk"]
    uvproj = layout["uvproj"]
    ytswarm_exe = layout["ytswarm"]

    if not mdk_dir.is_dir():
        print(f"error: missing directory {mdk_dir}", file=sys.stderr)
        return 1
    if not ytswarm_exe.is_file():
        print(f"error: missing YTSwarm.exe {ytswarm_exe}", file=sys.stderr)
        return 1

    print(f"clangd compile_commands flavor={layout['flavor']} uvproj={uvproj}")
    print(f"root={project_root}")
    result = subprocess.run([str(ytswarm_exe), uvproj], cwd=str(mdk_dir), shell=False)
    if result.returncode != 0:
        print(f"YTSwarm failed, exit code: {result.returncode}", file=sys.stderr)
        return result.returncode

    src = mdk_dir / "compile_commands.json"
    dst = project_root / "compile_commands.json"
    if not src.is_file():
        print(f"error: compile_commands.json not generated: {src}", file=sys.stderr)
        return 1

    with src.open(encoding="utf-8") as f:
        entries = json.load(f)
    fixed = absolutize_entries(entries, mdk_dir)
    with src.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(fixed, f, indent=4)
        f.write("\n")
    shutil.copy2(src, dst)
    print(f"compile_commands.json ready: {dst} ({len(fixed)} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
