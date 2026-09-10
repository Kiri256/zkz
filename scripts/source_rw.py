#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sandbox/source explicit-encoding R/W (Agent entry).

Subcommands:
  detect   <path>
  read     <path> [--start N] [--lines N] [--out file]
  write    <path> --from <file|->     (--from - = stdin, no temp file)
  replace-str <path> --old-str S --new-str S   (preferred, no temp file)
  replace-stdin <path> [--count N]            (stdin ---OLD--- / ---NEW---)
  replace  <path> --old <file> --new <file>   (legacy)
  check-fffd <path>
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def is_reparse_path(path: Path) -> bool:
    cur = path.resolve() if path.exists() else path
    for p in [cur, *cur.parents]:
        try:
            if p.is_symlink():
                return True
        except OSError:
            continue
        try:
            if p.exists() and p.is_dir():
                os.readlink(p)  # type: ignore[arg-type]
                return True
        except OSError:
            pass
        if p.parent == p:
            break
    return False


def detect_encoding(path: Path, forced: str | None = None) -> str:
    if forced and forced != "auto":
        return forced
    if is_reparse_path(path):
        return "gbk"
    if not path.is_file():
        return "utf-8"
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    try:
        raw.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        return "gbk"


def count_fffd(data: bytes) -> int:
    n = 0
    for i in range(max(0, len(data) - 2)):
        if data[i] == 0xEF and data[i + 1] == 0xBF and data[i + 2] == 0xBD:
            n += 1
    return n


def read_text(path: Path, encoding: str) -> str:
    enc = detect_encoding(path, encoding)
    return path.read_text(encoding=enc)


def write_text(path: Path, text: str, encoding: str) -> str:
    enc = detect_encoding(path, encoding)
    if enc == "utf-8-sig":
        enc = "utf-8"
    norm = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(norm.encode(enc))
    return enc


def _do_replace(path: Path, old: str, new: str, encoding: str, count_limit: int | None) -> int:
    text = read_text(path, encoding)
    crlf = "\r\n" in text
    if crlf:
        new_use = new.replace("\r\n", "\n").replace("\n", "\r\n")
        old_candidates = [
            old,
            old.replace("\r\n", "\n").replace("\n", "\r\n"),
            old.replace("\r\n", "\n"),
        ]
    else:
        new_use = new.replace("\r\n", "\n")
        old_candidates = [old, old.replace("\r\n", "\n"), old.replace("\n", "\r\n")]
    seen = set()
    count = 0
    for v in old_candidates:
        if not v or v in seen:
            continue
        seen.add(v)
        if v not in text:
            continue
        if count_limit is None:
            count = text.count(v)
            text = text.replace(v, new_use)
        else:
            count = min(text.count(v), int(count_limit))
            text = text.replace(v, new_use, int(count_limit))
        break
    if count == 0:
        print("ERROR: old text not found", file=sys.stderr)
        return 1
    enc = write_text(path, text, encoding)
    fffd = count_fffd(path.read_bytes())
    print(f"replaced={count} encoding={enc} fffd={fffd}")
    return 2 if fffd else 0


def cmd_detect(args: argparse.Namespace) -> int:
    path = Path(args.path)
    enc = detect_encoding(path, args.encoding)
    linked = is_reparse_path(path)
    fffd = count_fffd(path.read_bytes()) if path.is_file() else -1
    print(f"path={path}")
    print(f"exists={path.exists()}")
    print(f"reparse_ancestor={linked}")
    print(f"encoding={enc}")
    print(f"fffd={fffd}")
    return 0


def cmd_read(args: argparse.Namespace) -> int:
    path = Path(args.path)
    text = read_text(path, args.encoding)
    lines = text.splitlines(keepends=True)
    start = max(1, int(args.start or 1))
    if args.lines is not None:
        chunk = lines[start - 1 : start - 1 + int(args.lines)]
    else:
        chunk = lines[start - 1 :]
    out = "".join(chunk)
    if args.out:
        Path(args.out).write_text(out, encoding="utf-8", newline="\n")
        print(f"wrote_utf8={args.out} lines={len(chunk)} encoding={detect_encoding(path, args.encoding)}")
    else:
        sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))
        if not out.endswith("\n"):
            sys.stdout.buffer.write(b"\n")
    return 0


def cmd_write(args: argparse.Namespace) -> int:
    path = Path(args.path)
    if args.from_file == "-":
        text = sys.stdin.buffer.read().decode("utf-8")
    else:
        text = Path(args.from_file).read_text(encoding="utf-8")
    enc = write_text(path, text, args.encoding)
    fffd = count_fffd(path.read_bytes())
    print(f"wrote={path} encoding={enc} fffd={fffd}")
    return 2 if fffd else 0


def cmd_replace(args: argparse.Namespace) -> int:
    old = Path(args.old).read_text(encoding="utf-8")
    new = Path(args.new).read_text(encoding="utf-8")
    return _do_replace(Path(args.path), old, new, args.encoding, args.count)


def cmd_replace_str(args: argparse.Namespace) -> int:
    return _do_replace(Path(args.path), args.old_str, args.new_str, args.encoding, args.count)


def cmd_replace_stdin(args: argparse.Namespace) -> int:
    raw = sys.stdin.buffer.read().decode("utf-8")
    marker_old = "---OLD---"
    marker_new = "---NEW---"
    if marker_old not in raw or marker_new not in raw:
        print("ERROR: stdin must contain ---OLD--- and ---NEW--- sections", file=sys.stderr)
        return 1
    i_old = raw.index(marker_old) + len(marker_old)
    i_new = raw.index(marker_new)
    if i_new < i_old:
        print("ERROR: ---NEW--- must follow ---OLD---", file=sys.stderr)
        return 1
    old = raw[i_old:i_new]
    new = raw[i_new + len(marker_new) :]
    if old.startswith("\r\n"):
        old = old[2:]
    elif old.startswith("\n"):
        old = old[1:]
    if new.startswith("\r\n"):
        new = new[2:]
    elif new.startswith("\n"):
        new = new[1:]
    if new.endswith("\r\n"):
        new = new[:-2]
    elif new.endswith("\n"):
        new = new[:-1]
    return _do_replace(Path(args.path), old, new, args.encoding, args.count)


def cmd_check_fffd(args: argparse.Namespace) -> int:
    path = Path(args.path)
    n = count_fffd(path.read_bytes())
    print(f"fffd={n} path={path}")
    return 2 if n else 0


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="Explicit-encoding source read/write for zkz sandboxes")
    ap.add_argument("--encoding", default="auto", choices=["auto", "utf-8", "gbk", "utf-8-sig"])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("detect")
    p.add_argument("path")
    p.set_defaults(func=cmd_detect)

    p = sub.add_parser("read")
    p.add_argument("path")
    p.add_argument("--start", type=int, default=1)
    p.add_argument("--lines", type=int, default=None)
    p.add_argument("--out", default=None, help="optional UTF-8 file; prefer stdout (no temp)")
    p.set_defaults(func=cmd_read)

    p = sub.add_parser("write")
    p.add_argument("path")
    p.add_argument("--from", dest="from_file", required=True, help="UTF-8 file, or - for stdin")
    p.set_defaults(func=cmd_write)

    p = sub.add_parser("replace-str")
    p.add_argument("path")
    p.add_argument("--old-str", required=True)
    p.add_argument("--new-str", required=True)
    p.add_argument("--count", type=int, default=None)
    p.set_defaults(func=cmd_replace_str)

    p = sub.add_parser("replace-stdin")
    p.add_argument("path")
    p.add_argument("--count", type=int, default=None)
    p.set_defaults(func=cmd_replace_stdin)

    p = sub.add_parser("replace")
    p.add_argument("path")
    p.add_argument("--old", required=True, help="legacy: UTF-8 file with old snippet")
    p.add_argument("--new", required=True, help="legacy: UTF-8 file with new snippet")
    p.add_argument("--count", type=int, default=None)
    p.set_defaults(func=cmd_replace)

    p = sub.add_parser("check-fffd")
    p.add_argument("path")
    p.set_defaults(func=cmd_check_fffd)

    args = ap.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())