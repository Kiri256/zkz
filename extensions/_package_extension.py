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


def _copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
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


def main(name, files):
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
    write_version(pkg_json, version)
    out_vsix = os.path.join(ROOT, "%s-%s.vsix" % (name, version))

    stage = tempfile.mkdtemp(prefix="zkz-vsix-")
    try:
        _copy(pkg_json, os.path.join(stage, "package.json"))
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
        for rel in files:
            _copy(
                os.path.join(src, "src", *rel.split("/")),
                os.path.join(stage, "src", *rel.split("/")),
            )
        nm = os.path.join(src, "node_modules")
        if os.path.isdir(nm):
            shutil.copytree(
                nm,
                os.path.join(stage, "node_modules"),
                ignore=shutil.ignore_patterns(".bin"),
            )

        npx = "npx.cmd" if os.name == "nt" else "npx"
        cmd = [
            npx, "--yes", "@vscode/vsce", "package",
            "--allow-missing-repository",
            "--out", out_vsix,
        ]
        print("packing %s %s" % (name, version))
        r = subprocess.run(cmd, cwd=stage)
        if r.returncode != 0:
            return r.returncode
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    print("wrote %s" % out_vsix)
    return 0
