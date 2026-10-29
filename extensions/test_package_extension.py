"""Regression checks for package version updates without invoking npm."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import _package_extension as pack


class PackageVersionTests(unittest.TestCase):
    def check_pack(self, exit_code, produce_vsix):
        with tempfile.TemporaryDirectory(prefix="zkz-package-test-") as directory:
            root = Path(directory)
            source = root / "test-extension"
            source.mkdir()
            manifest = source / "package.json"
            manifest.write_text(json.dumps({"name": "test-extension", "version": "1.2.3"}), encoding="utf-8")
            (source / "README.md").write_text("Test extension\n", encoding="utf-8")

            def invoke(command, cwd):
                staged = json.loads((Path(cwd) / "package.json").read_text(encoding="utf-8"))
                self.assertEqual(staged["version"], "1.2.4")
                self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["version"], "1.2.3")
                if produce_vsix:
                    Path(command[-1]).write_bytes(b"test artifact")
                return SimpleNamespace(returncode=exit_code)

            with patch.object(pack, "ROOT", str(root)), patch.object(pack.subprocess, "run", side_effect=invoke):
                result = pack.main("test-extension", ())
            succeeded = exit_code == 0 and produce_vsix
            self.assertEqual(result, 0 if succeeded else (exit_code or 1))
            self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["version"], "1.2.4" if succeeded else "1.2.3")

    def test_failed_package_preserves_version(self):
        self.check_pack(1, False)

    def test_success_updates_version(self):
        self.check_pack(0, True)

    def test_missing_artifact_preserves_version(self):
        self.check_pack(0, False)

    def test_load_shared_copies_are_identical(self):
        root = Path(__file__).resolve().parent
        texts = [
            (root / name / "src" / "load_shared.js").read_bytes()
            for name in ("zkz-native", "zkz-code", "zkz-keil")
        ]
        self.assertEqual(texts[0], texts[1])
        self.assertEqual(texts[0], texts[2])

    def test_stage_keeps_source_and_copies_shared_closure(self):
        with tempfile.TemporaryDirectory(prefix="zkz-package-shared-") as directory:
            root = Path(directory)
            source = root / "zkz-demo"
            (source / "src").mkdir(parents=True)
            (root / "shared").mkdir()
            (source / "package.json").write_text(
                json.dumps({"name": "zkz-demo", "version": "0.0.1"}),
                encoding="utf-8",
            )
            (source / "README.md").write_text("demo\n", encoding="utf-8")
            src_js = "const loadShared = require('./load_shared');\nconst settings = loadShared('alpha');\n"
            (source / "src" / "main.js").write_text(src_js, encoding="utf-8", newline="\n")
            (source / "src" / "load_shared.js").write_text("module.exports = function loadShared() {};\n", encoding="utf-8", newline="\n")
            (root / "shared" / "alpha.js").write_text("require('./beta');\n", encoding="utf-8", newline="\n")
            (root / "shared" / "beta.js").write_text("'use strict';\n", encoding="utf-8", newline="\n")

            def invoke(command, cwd):
                staged = Path(cwd)
                self.assertEqual((staged / "src" / "main.js").read_text(encoding="utf-8"), src_js)
                self.assertTrue((staged / "src" / "shared" / "alpha.js").is_file())
                self.assertTrue((staged / "src" / "shared" / "beta.js").is_file())
                Path(command[-1]).write_bytes(b"test artifact")
                return SimpleNamespace(returncode=0)

            with patch.object(pack, "ROOT", str(root)), patch.object(pack.subprocess, "run", side_effect=invoke):
                result = pack.main("zkz-demo", ("main.js", "load_shared.js"))
            self.assertEqual(result, 0)

    def test_direct_shared_require_fails_before_pack(self):
        with tempfile.TemporaryDirectory(prefix="zkz-package-forbid-") as directory:
            root = Path(directory)
            source = root / "zkz-demo"
            (source / "src").mkdir(parents=True)
            (source / "package.json").write_text(
                json.dumps({"name": "zkz-demo", "version": "0.0.1"}),
                encoding="utf-8",
            )
            (source / "README.md").write_text("demo\n", encoding="utf-8")
            (source / "src" / "main.js").write_text("require('../../shared/alpha');\n", encoding="utf-8", newline="\n")
            with patch.object(pack, "ROOT", str(root)), patch.object(pack.subprocess, "run") as run:
                with self.assertRaises(SystemExit):
                    pack.main("zkz-demo", ("main.js",))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
