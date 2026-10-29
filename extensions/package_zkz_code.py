import json
import os
import shutil

from _package_extension import main

# require('fast-xml-parser') 只加载 lib/fxp.cjs。iconv 只解 gb18030/gbk，表只留这三份。
# encodings/index.js 会加载全部编码模块，那些模块启动时 require('safer-buffer')。
_FXP_KEEP = (
    "package.json",
    os.path.join("lib", "fxp.cjs"),
)
_ICONV_TABLES = ("cp936.json", "gbk-added.json", "gb18030-ranges.json")
_SAFER_KEEP = ("package.json", "safer.js")
_KEEP_TOPS = ("fast-xml-parser", "iconv-lite", "safer-buffer")


def _keep_only(root, rels):
    keep = set()
    for rel in rels:
        path = os.path.normpath(os.path.join(root, rel))
        if not os.path.isfile(path):
            raise SystemExit("pack keep missing: %s" % path)
        keep.add(path)
    for dirpath, _dirnames, filenames in os.walk(root, topdown=False):
        for filename in filenames:
            path = os.path.normpath(os.path.join(dirpath, filename))
            if path not in keep:
                os.remove(path)
        if os.path.normpath(dirpath) != os.path.normpath(root) and not os.listdir(dirpath):
            os.rmdir(dirpath)


def _iconv_keep(root):
    rels = ["package.json"]
    for folder in ("lib", "encodings"):
        base = os.path.join(root, folder)
        for dirpath, _dirnames, filenames in os.walk(base):
            if os.path.basename(dirpath) == "tables":
                continue
            for filename in filenames:
                if filename.endswith(".js"):
                    rels.append(os.path.relpath(os.path.join(dirpath, filename), root))
    for name in _ICONV_TABLES:
        rels.append(os.path.join("encodings", "tables", name))
    return rels


def _drop_declared_deps(pkg_json):
    """fxp.cjs 已内含解析器。留下 dependencies 时 vsce 的 npm list 会把裁掉的包当成缺失。"""
    with open(pkg_json, "r", encoding="utf-8") as f:
        meta = json.load(f)
    meta.pop("dependencies", None)
    meta.pop("devDependencies", None)
    with open(pkg_json, "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")


def prune_node_modules(nm):
    for name in os.listdir(nm):
        if name in _KEEP_TOPS:
            continue
        path = os.path.join(nm, name)
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
    fxp = os.path.join(nm, "fast-xml-parser")
    _keep_only(fxp, _FXP_KEEP)
    _drop_declared_deps(os.path.join(fxp, "package.json"))
    iconv = os.path.join(nm, "iconv-lite")
    _keep_only(iconv, _iconv_keep(iconv))
    _keep_only(os.path.join(nm, "safer-buffer"), _SAFER_KEEP)


if __name__ == "__main__":
    raise SystemExit(main("zkz-code", (
        "extension.js", "status.js", "status_bar.js", "util.js", "macros.js", "pp_expr.js", "macro_impact.js",
        "ifdef_fold.js", "encoding.js", "load_shared.js", "lists.js",
        "compile_commands.js", "cc_stamp.js", "head_watch.js", "cmsis.js", "workspace_lists.json",
    ), prune_node_modules))
