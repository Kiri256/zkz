from _package_extension import main


if __name__ == "__main__":
    raise SystemExit(main("zkz-keil", (
        "extension.js", "status_bar.js", "keil.js", "keil_flash.js", "keil_tasks.js",
        "keil_layout.js", "keil_config.js", "keil_launch.js", "load_shared.js",
    )))
