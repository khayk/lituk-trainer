# LITUK Trainer

A local-first study app for the Life in the UK test. It imports the result PDFs you save from practice tests on
lifeintheuktestweb.co.uk into a personal question bank, then drills your mistakes with spaced repetition, timed mock
exams and progress tracking.

> Unofficial. Not affiliated with the Home Office or lifeintheuktestweb.co.uk. No questions are included in this
> repository; the app only uses the PDFs you add yourself.

## Run

    git clone https://github.com/khayk/lituk-trainer.git
    cd lituk-trainer
    python3 server.py        # or double-click start.command

It opens http://127.0.0.1:8765. Requires Python 3 and poppler (`pdftohtml`, `brew install poppler`); nothing else.

Options: `--port 9000`, `--pdf-dir /some/folder` (default: `pdfs/` next to `server.py`), `--no-browser`.

## Adding tests

Put `test-<n>-<errors>e.pdf` or `exam-<n>-<errors>e.pdf` files in `pdfs/` (any `<name>-<n>-<errors>e.pdf` works; the prefix becomes the label, e.g. "Exam 17"). They are imported automatically when the server starts, or you can
click **Scan folder for new PDFs** (or drag PDFs onto the dashboard). Every question in the test is imported:
bold options become the correct answers, and the questions you got wrong are marked as mistakes.
If the counts don't match the PDF header or filename, the test gets a ⚠ badge, and you can fix the question in the question bank.

## How practice works

* **Fix my mistakes**: questions you got wrong (in a test or in the app) that you haven't mastered yet.
* **Spaced review**: a Leitner system. A right answer on a question that is due moves it up a box (next review in
  1, 2, 4, 8… days); answering it again before then is recorded but doesn't move it. A wrong answer always sends it
  back to box 0. Box 3+ counts as **mastered**, so mastery takes right answers on at least three separate days.
* **Mock exam**: 24 random questions, 45 minutes, 75% to pass, results only at the end.
* **Weakest / Flagged / Everything**, plus per-test **Mistakes** and **Retake** buttons.

In practice modes a wrong answer is asked again at the end of the round. Keys: `1`–`6` choose, `Enter` check/next, `F` flag.

## Data

Everything is in `data/db.json` (plain JSON). A copy goes to `data/backups/` before every import, delete or reset
(the last 20 are kept). **Download backup** on the dashboard exports it. `data/` and `pdfs/` are git-ignored, so your
progress and PDFs never end up in the repository.

## License

[AGPL-3.0](LICENSE)
