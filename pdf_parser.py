"""Parse result PDFs exported from lifeintheuktestweb.co.uk.

The PDF is converted with poppler's `pdftohtml -xml`, which keeps each text
fragment's position and whether it is bold. On these pages:

  * question text   -> bold, x ~= 39
  * answer options  -> x ~= 66, the correct option(s) are bold
  * result box      -> x ~= 49, first line is "Correct" / "Incorrect",
                       followed by the explanation
"""

import html
import re
import subprocess
from pathlib import Path

TEXT_RE = re.compile(
    r'<text top="(-?\d+)" left="(-?\d+)" width="\d+" height="(\d+)" font="\d+">(.*?)</text>'
)
PAGE_RE = re.compile(r"<page ")
TAG_RE = re.compile(r"<[^>]+>")
SKIP_RE = re.compile(r"^\(?https?://\S*\)?$")
FILENAME_RE = re.compile(r"^(?P<name>(?P<kind>.+?)-(?P<num>\d+))(?:-(?P<errors>\d+)e)?$", re.I)


class ParseError(Exception):
    pass


def pdf_to_xml(pdf_path):
    try:
        return subprocess.run(
            ["pdftohtml", "-xml", "-i", "-stdout", "-q", str(pdf_path)],
            capture_output=True, text=True, check=True,
        ).stdout
    except FileNotFoundError:
        raise ParseError("pdftohtml not found - install poppler (brew install poppler)")
    except subprocess.CalledProcessError as e:
        raise ParseError(f"pdftohtml failed: {e.stderr.strip()}")


def _fragments(xml):
    # Split by page so that each page can be sorted top-to-bottom.
    pages = PAGE_RE.split(xml)[1:]
    for page_no, page in enumerate(pages):
        frags = []
        for m in TEXT_RE.finditer(page):
            top, left, height, inner = int(m[1]), int(m[2]), int(m[3]), m[4]
            text = html.unescape(TAG_RE.sub("", inner)).strip()
            if not text or SKIP_RE.match(text):
                continue
            frags.append({
                "page": page_no, "top": top, "left": left, "height": height,
                "bold": "<b>" in inner, "text": text,
            })
        frags.sort(key=lambda f: (f["top"], f["left"]))
        yield from frags


def _join(parts):
    text = re.sub(r"\s+", " ", " ".join(parts)).strip()
    return re.sub(r"\s+([.,;:!?)])", r"\1", text)


def parse_pdf(pdf_path):
    return parse_xml(pdf_to_xml(pdf_path), Path(pdf_path).name)


def parse_xml(xml, filename):
    """Parse `pdftohtml -xml` output; `filename` (e.g. "test-11-4e.pdf") names the test."""
    pdf_path = Path(filename)
    frags = list(_fragments(xml))
    full_text = " ".join(f["text"] for f in frags)

    score = total = None
    m = re.search(r"(\d+)\s+of\s+(\d+)\s+questions answered correctly", full_text)
    if m:
        score, total = int(m[1]), int(m[2])

    questions = []
    q = None
    state = "pre"  # pre -> question -> option -> explanation
    prev = None

    def finish():
        if q and q["options"] and q["result"]:
            questions.append({
                "text": _join(q["text"]),
                "options": [_join(o["text"]) for o in q["options"]],
                "correct": [i for i, o in enumerate(q["options"]) if o["bold"]],
                "result": q["result"],
                "explanation": _join(q["explanation"]),
            })

    for f in frags:
        if state == "pre":
            if f["text"].startswith("Click on the question numbers"):
                state = "numbers"
            continue
        if total and len(questions) >= total:
            break

        left, bold, text = f["left"], f["bold"], f["text"]
        same_line = prev is not None and prev["page"] == f["page"] and abs(prev["top"] - f["top"]) <= 4
        gap = (f["top"] - prev["top"]) if prev is not None and prev["page"] == f["page"] else 0

        if 30 <= left <= 44 and bold:
            if state == "question":
                q["text"].append(text)
            else:
                finish()
                q = {"text": [text], "options": [], "result": None, "explanation": []}
                state = "question"
        elif state in ("question", "option") and 44 < left <= 56 and bold and text in ("Correct", "Incorrect"):
            q["result"] = text.lower()
            state = "explanation"
        elif state in ("question", "option") and 56 < left <= 80:
            if state == "option" and 0 < gap < 28:
                # Wrapped second line of a long option.
                q["options"][-1]["text"].append(text)
                q["options"][-1]["bold"] |= bold
            else:
                q["options"].append({"text": [text], "bold": bold})
            state = "option"
        elif state == "option" and same_line:
            q["options"][-1]["text"].append(text)
            q["options"][-1]["bold"] |= bold
        elif state == "explanation":
            if 14 <= f["height"] <= 18 and (same_line or (44 < left <= 56 and gap < 32)):
                q["explanation"].append(text)
            else:
                # Anything else ends the result box (ads, footer, related tests).
                state = "done"
                continue
        else:
            continue
        prev = f
    finish()

    if not questions:
        raise ParseError("no questions found - is this a lifeintheuktestweb results PDF?")

    m = FILENAME_RE.match(pdf_path.stem)
    # Leading zeros are dropped so "test-01-1e" and "test-1-1e" are the same test.
    test_id = f"{m['kind'].lower()}-{int(m['num'])}" if m else pdf_path.stem.lower()
    # "test-11-4e" -> "Test 11", "exam-17-2e" -> "Exam 17"
    title = f"{m['kind'].replace('-', ' ').capitalize()} {int(m['num'])}" if m else pdf_path.stem
    expected_errors = int(m["errors"]) if m and m["errors"] else None

    warnings = []
    wrong = sum(1 for x in questions if x["result"] == "incorrect")
    if total and len(questions) != total:
        warnings.append(f"found {len(questions)} questions but the PDF says {total}")
    if expected_errors is not None and wrong != expected_errors:
        warnings.append(f"found {wrong} incorrect answers but the filename says {expected_errors}")
    for i, x in enumerate(questions, 1):
        if not x["correct"]:
            warnings.append(f"question {i} has no answer marked as correct")

    return {
        "test_id": test_id,
        "title": title,
        "file": pdf_path.name,
        "score": score if score is not None else len(questions) - wrong,
        "total": total or len(questions),
        "questions": questions,
        "warnings": warnings,
    }


if __name__ == "__main__":
    import json
    import sys

    for p in sys.argv[1:]:
        print(json.dumps(parse_pdf(p), indent=2, ensure_ascii=False))
