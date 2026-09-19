from _package_extension import main


if __name__ == "__main__":
    raise SystemExit(main("zkz-code", (
        "extension.js", "status.js", "util.js", "macros.js", "macro_impact.js",
        "ifdef_fold.js", "encoding.js", "pair.js", "fffd.js", "lists.js",
        "toast.js", "compile_commands.js", "workspace_lists.json",
    )))
