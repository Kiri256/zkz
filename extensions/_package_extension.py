# -*- coding: utf-8 -*-
"""Stage whitelist sources and write <name>-<version>.vsix next to this script."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))


LOAD_SHARED_RE = re.compile(r"loadShared\(\s*'([A-Za-z0-9_]+)'\s*\)")
REL_SHARED_RE = re.compile(r"require\(\s*'\./([A-Za-z0-9_]+)'\s*\)")
FORBIDDEN_SHARED_RE = re.compile(r"""require\(\s*['"](?:\.\./\.\./shared|\./shared)/""")


def _copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)


def shared_names_in_source(text):
    return LOAD_SHARED_RE.findall(text)


def assert_no_direct_shared_require(text, label):
    if FORBIDDEN_SHARED_RE.search(text):
        raise SystemExit("src 里不要直接 require shared，用 loadShared: %s" % label)


def close_shared(names):
    pending = list(names)
    seen = []
    seen_set = set()
    while pending:
        name = pending.pop(0)
        if name in seen_set:
            continue
        seen_set.add(name)
        seen.append(name)
        shared = os.path.join(ROOT, "shared", name + ".js")
        if not os.path.isfile(shared):
            raise SystemExit("missing shared/%s.js" % name)
        with open(shared, "r", encoding="utf-8") as f:
            text = f.read()
        for dep in REL_SHARED_RE.findall(text):
            if dep not in seen_set:
                pending.append(dep)
    return seen


def _stage_source(src, dst, shared_needed):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if src.endswith(".js"):
        with open(src, "rb") as f:
            raw = f.read()
        text = raw.decode("utf-8")
        assert_no_direct_shared_require(text, src)
        for name in shared_names_in_source(text):
            shared_needed.add(name)
    shutil.copy2(src, dst)


def bump_patch(version):
    parts = str(version or "0.0.0").split(".")
    while len(parts) < 3:
        parts.append("0")
    try:
        parts[-1] = str(int(parts[-1]) + 1)
    except ValueError:
        parts.append("1")
    return ".".join(parts)


def write_version(pkg_json, new_version):
    with open(pkg_json, "r", encoding="utf-8") as f:
        text = f.read()
    new_text, n = re.subn(
        r'("version"\s*:\s*")([^"]+)(")',
        r"\g<1>" + new_version + r"\g<3>",
        text,
        count=1,
    )
    if n != 1:
        raise SystemExit("cannot bump version in %s" % pkg_json)
    newline = "\r\n" if "\r\n" in text else "\n"
    with open(pkg_json, "w", encoding="utf-8", newline=newline) as f:
        f.write(new_text)


def main(name, files, prune_node_modules=None):
    src = os.path.join(ROOT, name)
    pkg_json = os.path.join(src, "package.json")
    readme = os.path.join(src, "README.md")
    rels = ["package.json", "README.md"] + ["src/" + rel for rel in files]
    missing = [rel for rel in rels if not os.path.isfile(os.path.join(src, *rel.split("/")))]
    if missing:
        sys.stderr.write("%s missing:\n  %s\n" % (name, "\n  ".join(missing)))
        return 1

    with open(pkg_json, "r", encoding="utf-8") as f:
        meta = json.load(f)
    version = bump_patch(meta.get("version") or "0.0.0")
    out_vsix = os.path.join(ROOT, "%s-%s.vsix" % (name, version))

    stage = tempfile.mkdtemp(prefix="zkz-vsix-")
    try:
        _copy(pkg_json, os.path.join(stage, "package.json"))
        write_version(os.path.join(stage, "package.json"), version)
        _copy(readme, os.path.join(stage, "README.md"))
        license_copied = False
        for license_name in ("LICENSE", "LICENSE.md", "LICENSE.txt"):
            lic = os.path.join(src, license_name)
            if os.path.isfile(lic):
                _copy(lic, os.path.join(stage, license_name))
                license_copied = True
                break
        if not license_copied:
            shared = os.path.join(ROOT, "LICENSE")
            if os.path.isfile(shared):
                _copy(shared, os.path.join(stage, "LICENSE"))

        media = os.path.join(src, "media")
        if os.path.isdir(media):
            shutil.copytree(media, os.path.join(stage, "media"))
        shared_needed = set()
        for rel in files:
            _stage_source(
                os.path.join(src, "src", *rel.split("/")),
                os.path.join(stage, "src", *rel.split("/")),
                shared_needed,
            )
        for shared_name in close_shared(shared_needed):
            shared = os.path.join(ROOT, "shared", shared_name + ".js")
            _copy(shared, os.path.join(stage, "src", "shared", shared_name + ".js"))
        nm = os.path.join(src, "node_modules")
        if os.path.isdir(nm):
            shutil.copytree(
                nm,
                os.path.join(stage, "node_modules"),
                ignore=shutil.ignore_patterns(".bin"),
            )
            if prune_node_modules:
                prune_node_modules(os.path.join(stage, "node_modules"))

        npx = "npx.cmd" if os.name == "nt" else "npx"
        cmd = [
            npx, "--yes", "@vscode/vsce", "package",
            "--allow-missing-repository",
            "--out", out_vsix,
        ]
        print("packing %s %s" % (name, version), flush=True)
        r = subprocess.run(cmd, cwd=stage)
        if r.returncode != 0:
            return r.returncode
        if not os.path.isfile(out_vsix):
            sys.stderr.write("packaging succeeded but VSIX is missing: %s\n" % out_vsix)
            return 1
        write_version(pkg_json, version)
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    print("wrote %s" % out_vsix)
    return 0
