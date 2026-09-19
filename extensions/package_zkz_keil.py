from _package_extension import main


if __name__ == "__main__":
    raise SystemExit(main("zkz-keil", (
        "extension.js", "keil.js", "keil_flash.js", "keil_tasks.js",
        "keil_layout.js", "pair.js",
    )))
