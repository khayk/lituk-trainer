# UK Test Trainer

A local quiz app built from your lifeintheuktestweb.co.uk result PDFs.

## Run

    python3 quiz-app/server.py        # or double-click quiz-app/start.command

It opens http://127.0.0.1:8765. Requires Python 3 and poppler (`pdftohtml`, `brew install poppler`); nothing else.

Options: `--port 9000`, `--pdf-dir /some/folder` (default: the folder above `quiz-app`), `--no-browser`.

## Adding tests

Put new `test-<n>-<errors>e.pdf` files in the PDF folder. They are imported automatically when the server starts, or you can
click **Scan folder for new PDFs** (or drag PDFs onto the dashboard). Every question in the test is imported:
bold options become the correct answers, and the questions you got wrong are marked as mistakes.
If the counts don't match the PDF header or filename, the test gets a ⚠ badge, and you can fix the question in the question bank.

## How practice works

* **Fix my mistakes**: questions you got wrong (in a test or in the app) that you haven't mastered yet.
* **Spaced review**: a Leitner system. A right answer moves a question up a box (next review in 1, 2, 4, 8… days);
  a wrong answer sends it back to box 0. Box 3+ counts as **mastered**.
* **Mock exam**: 24 random questions, 45 minutes, 75% to pass, results only at the end.
* **Weakest / Flagged / Everything**, plus per-test **Mistakes** and **Retake** buttons.

In practice modes a wrong answer is asked again at the end of the round. Keys: `1`–`6` choose, `Enter` check/next, `F` flag.

## Data

Everything is in `data/db.json` (plain JSON). A copy goes to `data/backups/` before every import, delete or reset
(the last 20 are kept). **Download backup** on the dashboard exports it.
