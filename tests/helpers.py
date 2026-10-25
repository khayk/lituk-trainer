"""Shared test helpers: a temporary data folder, a controllable clock and fake import results."""

import shutil
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

import server

FIXTURES = Path(__file__).parent / "fixtures"


class TempData:
    """Point the server at an empty temporary data folder and PDF folder."""

    def __enter__(self):
        self.root = Path(tempfile.mkdtemp(prefix="lituk-test-"))
        self.pdfs = self.root / "pdfs"
        self.pdfs.mkdir()
        self._saved = (server.DATA_DIR, server.DB_PATH, server.PDF_DIR)
        server.DATA_DIR = self.root / "data"
        server.DB_PATH = server.DATA_DIR / "db.json"
        server.PDF_DIR = self.pdfs
        return self

    def __exit__(self, *exc):
        server.DATA_DIR, server.DB_PATH, server.PDF_DIR = self._saved
        shutil.rmtree(self.root, ignore_errors=True)


class FrozenClock:
    """Replace the server's notion of "now" with a time the test controls."""

    def __init__(self, when):
        self.when = when

    def advance(self, **delta):
        self.when += timedelta(**delta)

    def __enter__(self):
        clock = self

        class FakeDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return clock.when

        class FakeDate(date):
            @classmethod
            def today(cls):
                return clock.when.date()

        self._saved = (server.datetime, server.date)
        server.datetime, server.date = FakeDateTime, FakeDate
        return self

    def __exit__(self, *exc):
        server.datetime, server.date = self._saved


def question(text, options, correct, result="correct", explanation=""):
    return {"text": text, "options": options, "correct": correct, "result": result, "explanation": explanation}


def parsed(test_id, questions, file=None):
    """A result in the shape pdf_parser.parse_pdf returns."""
    wrong = sum(q["result"] == "incorrect" for q in questions)
    return {
        "test_id": test_id, "title": test_id.replace("-", " ").title(), "file": file or f"{test_id}.pdf",
        "score": len(questions) - wrong, "total": len(questions), "questions": questions, "warnings": [],
    }


class FakeParser:
    """Stands in for server.parse_pdf: returns a prepared result per file name."""

    def __init__(self, results):
        self.results = {r["file"]: r for r in results}

    def __call__(self, path):
        return self.results[Path(path).name]

    def __enter__(self):
        self._saved = server.parse_pdf
        server.parse_pdf = self
        return self

    def __exit__(self, *exc):
        server.parse_pdf = self._saved


def write_pdfs(folder, results):
    """Create placeholder files so imports find them on disk."""
    for r in results:
        (folder / r["file"]).write_bytes(b"%PDF-1.4 placeholder")
