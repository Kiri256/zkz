from _package_extension import main


if __name__ == "__main__":
    raise SystemExit(main("zkz-code", (
        "extension.js", "status.js", "status_bar.js", "util.js", "macros.js", "pp_expr.js", "macro_impact.js",
        "ifdef_fold.js", "encoding.js", "pair.js", "fffd.js", "lists.js",
        "compile_commands.js", "cc_stamp.js", "head_watch.js", "workspace_lists.json",
    )))
