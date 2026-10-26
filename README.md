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

## How progress works

Every question has a **streak**: right answers in a row on separate days. A right answer counts as a **step** if it
is on a later calendar day than the last one that counted (answering again the same day is recorded but adds
nothing); a wrong answer resets the streak to 0. Three steps = **mastered**. Mastered questions come back for a check
after 4, 8, 16 and 32 days, and a wrong answer there starts them over.

Each question is in exactly one state, the highest that applies:

* **Mastered**: streak of 3 or more.
* **Learning**: answered at least once, here or in a PDF (shown as step 0, 1 or 2).
* **New**: never answered.

**Missed before** is a permanent mark, not a state: the question was answered wrong at least once, here or in a
PDF. A question you got right in a PDF starts at step 1; one you got wrong starts at step 0 with the mark.

The dashboard shows **Today** (steps earned, newly mastered, slipped back, and with a test date, today's goal), and
**Where your questions are**: one bar of New / Learning (by step) / Mastered. Click any part to open those questions
in the question bank; click Learning to see its steps in detail.

The question bank shows how many times each question was answered right (✓) and wrong (✗): one per PDF it was in,
plus the first answer in each quiz (a second chance in the same round doesn't count). The bank can be sorted by
these, by state, and more, in either direction.

**Reset progress** goes back to just after importing your PDFs and keeps the counters. **Start from blank** makes
every question New, with counters at 0 and no missed marks.

## Quiz modes

* **Exam plan**: set your test date on the dashboard. Only questions where a right answer counts today, furthest
  from mastered first. When fewer study days are left than steps needed, steps may be 3 hours apart instead of a
  day, and mastered questions get one last check before the day. After the exam date the normal rules apply again.
* **Ready to count**: every question where a right answer would count right now.
* **Missed, not yet mastered**: questions with the missed-before mark that aren't mastered.
* **Mock exam**: 24 random questions, 45 minutes, 75% to pass, results only at the end.
* **Weakest / Flagged / Everything**, plus per-test **Mistakes** and **Retake** buttons.

After each quiz the results show the steps it earned, questions newly mastered and questions that slipped back.

In practice modes a wrong answer is asked again at the end of the round. Keys: `1`–`6` choose, `Enter` check/next, `F` flag.

## Data

Everything is in `data/db.json` (plain JSON). A copy goes to `data/backups/` before every import, delete or reset
(the last 20 are kept). **Download backup** on the dashboard exports it. `data/` and `pdfs/` are git-ignored, so your
progress and PDFs never end up in the repository.

## Development

Run the tests from the repository root (standard library only, about 2 seconds):

    python3 -m unittest

They cover the PDF parser (against a synthetic results page in `tests/fixtures/`), import and merging, spaced
repetition, the exam-date schedule, the right/wrong counters and the HTTP API. If you have PDFs in `pdfs/`, one extra
test checks that every one of them imports cleanly; without them it is skipped. GitHub runs the suite on every push.

## License

[AGPL-3.0](LICENSE)
