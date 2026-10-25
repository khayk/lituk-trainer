"""Cheap checks on the browser code. The UI logic itself is covered only by manual/browser testing."""

import re
import shutil
import subprocess
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "static"


class StaticFilesTest(unittest.TestCase):
    def test_index_references_existing_files(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        for ref in re.findall(r'(?:src|href)="([^":#]+)"', html):
            with self.subTest(ref=ref):
                self.assertTrue((STATIC / ref).exists(), f"index.html links to missing {ref}")

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_app_js_has_no_syntax_errors(self):
        result = subprocess.run(["node", "--check", str(STATIC / "app.js")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
