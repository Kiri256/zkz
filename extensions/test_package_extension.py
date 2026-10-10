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


if __name__ == "__main__":
    unittest.main()
