#!/usr/bin/env python3
"""Generate compile_commands.json on W1 via YTSwarm, then copy to W1 and *U."""

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
    """Pick H750_N vs F429 b_01 by workspace folder name + uvprojx presence."""
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


def _read_source_root(root: Path):
    for rel in (Path(".zkz") / ".workspace_sync_meta.json", Path(".workspace_sync_meta.json")):
        meta = root / rel
        if not meta.is_file():
            continue
        try:
            obj = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeError):
            continue
        src = str((obj or {}).get("sourceRoot") or "").strip()
        if not src:
            continue
        p = Path(src)
        if p.is_dir():
            return p.resolve()
    return None


def resolve_w1_sandbox(project_root: Path):
    """Return (w1, sandbox_or_None). Project/YTSwarm live on W1 only."""
    project_root = Path(project_root).resolve()
    name = project_root.name
    meta_w1 = _read_source_root(project_root)
    if meta_w1 is not None and meta_w1 != project_root:
        return meta_w1, project_root

    if name.endswith("U") and not name.endswith(" - U"):
        sibling = project_root.parent / name[:-1]
        if sibling.is_dir():
            return sibling.resolve(), project_root

    sandbox = project_root.parent / (name + "U")
    if sandbox.is_dir():
        return project_root, sandbox.resolve()
    return project_root, None


def rewrite_paths_to_sandbox(text: str, w1: Path, sandbox: Path) -> str:
    """Rewrite W1-absolute paths to sandbox; keep Project on W1.

    Same replace order as zkz-code compile_commands.js rewritePaths.
    """
    w1_s = str(w1)
    sb_s = str(sandbox)
    src_fwd = w1_s.replace("\\", "/")
    dst_fwd = sb_s.replace("\\", "/")
    src_esc = w1_s.replace("\\", "\\\\")
    dst_esc = sb_s.replace("\\", "\\\\")
    text = text.replace(src_esc, dst_esc).replace(src_fwd, dst_fwd).replace(w1_s, sb_s)

    u_proj = str(sandbox / "Project")
    w1_proj = str(w1 / "Project")
    text = (
        text.replace(u_proj.replace("\\", "\\\\"), w1_proj.replace("\\", "\\\\"))
        .replace(u_proj.replace("\\", "/"), w1_proj.replace("\\", "/"))
        .replace(u_proj, w1_proj)
    )
    return text


def copy_to_sandbox(w1_cc: Path, w1: Path, sandbox: Path) -> Path:
    text = w1_cc.read_text(encoding="utf-8")
    text = rewrite_paths_to_sandbox(text, w1, sandbox)
    dst = sandbox / "compile_commands.json"
    with dst.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return dst


def absolutize_entries(entries: list, mdk: Path) -> list:
    """Absolutize file/-I relative to the Keil MDK directory."""
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

    w1, sandbox = resolve_w1_sandbox(project_root)
    layout = resolve_keil_layout(w1)
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
    print(f"W1={w1}")
    if sandbox is not None:
        print(f"sandbox={sandbox}")
    result = subprocess.run([str(ytswarm_exe), uvproj], cwd=str(mdk_dir), shell=False)
    if result.returncode != 0:
        print(f"YTSwarm failed, exit code: {result.returncode}", file=sys.stderr)
        return result.returncode

    src = mdk_dir / "compile_commands.json"
    dst = w1 / "compile_commands.json"
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
    print(f"compile_commands.json ready on W1: {dst} ({len(fixed)} entries)")

    if sandbox is None:
        print("sandbox not found, skip *U copy")
        return 0
    dst_u = copy_to_sandbox(dst, w1, sandbox)
    print(f"compile_commands.json ready on sandbox: {dst_u}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
