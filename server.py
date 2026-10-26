#!/usr/bin/env python3
"""Local Life in the UK quiz app.

    python3 server.py              # serves http://127.0.0.1:8765, PDFs from ./pdfs/
    python3 server.py --port 9000 --pdf-dir ~/somewhere --no-browser

All data lives in data/db.json next to this file.
"""

import argparse
import hashlib
import json
import os
import sys
import re
import shutil
import threading
import time
import webbrowser
from datetime import date, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote

from pdf_parser import ParseError, parse_pdf

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = APP_DIR / "data"
DB_PATH = DATA_DIR / "db.json"

# Progress model (version 2). Each question has:
#   streak        right answers in a row that counted; MASTERED_STREAK of them = mastered
#   last_counted  when the last counting answer happened (None after a wrong answer)
#   flags         practised (answered at least once, here or in a PDF) and missed (ever
#                 wrong, here or in a PDF); both are permanent until "start from blank"
#   counts        lifetime right/wrong: one per PDF the question was in, one per quiz
# A right answer counts only on a later calendar day than the last one that counted.
# A wrong answer resets the streak, so mastery means right on MASTERED_STREAK separate
# days with no miss in between. Mastered questions get a check after CHECK_DAYS.
MASTERED_STREAK = 3
CHECK_DAYS = [4, 8, 16, 32]
MAX_STREAK = MASTERED_STREAK + len(CHECK_DAYS)
# With an exam coming up and fewer study days left than steps needed, steps may be this close.
SAME_DAY_GAP_HOURS = 3
DB_VERSION = 2

lock = threading.Lock()
DEFAULT_PDF_DIR = APP_DIR / "pdfs"
PDF_DIR = DEFAULT_PDF_DIR


# ---------------------------------------------------------------- storage

def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def empty_db():
    return {"version": DB_VERSION, "counts_backfilled": True, "tests": {}, "questions": {},
            "sessions": [], "daily": {}}


def load_db():
    if not DB_PATH.exists():
        return empty_db()
    with open(DB_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_db(db):
    DATA_DIR.mkdir(exist_ok=True)
    tmp = DB_PATH.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=1, ensure_ascii=False)
    os.replace(tmp, DB_PATH)


def backup_db():
    if DB_PATH.exists():
        backups = DATA_DIR / "backups"
        backups.mkdir(exist_ok=True)
        shutil.copy2(DB_PATH, backups / f"db-{datetime.now():%Y%m%d-%H%M%S}.json")
        for old in sorted(backups.glob("db-*.json"))[:-20]:
            old.unlink()


def norm(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower().replace("’", "'")).strip()


def question_id(text, options):
    key = norm(text) + "|" + "|".join(sorted(norm(o) for o in options))
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def new_stats(streak=0, last_counted=None):
    return {"streak": streak, "last_counted": last_counted, "due": None,
            "seen": 0, "right": 0, "last_seen": None, "history": []}


def pdf_results(q):
    return [s["result"] for s in q["sources"] if s["result"] in ("correct", "incorrect")]


def start_from_pdfs(db, q):
    """Progress as it stands right after importing the question's PDFs (no practice here)."""
    results = pdf_results(q)
    missed = "incorrect" in results
    streak = 0 if missed or not results else 1
    q["stats"] = new_stats(streak, now_iso() if streak else None)
    q["flags"] = {"practised": bool(results), "missed": missed}
    refresh_due(db, q)


# ---------------------------------------------------------------- import

def import_pdf(db, path):
    parsed = parse_pdf(path)
    test_id = parsed["test_id"]
    qids = []
    for q in parsed["questions"]:
        qid = question_id(q["text"], q["options"])
        qids.append(qid)
        source = {"test": test_id, "result": q["result"]}
        existing = db["questions"].get(qid)
        if existing:
            # Re-importing the same test changes nothing; a new test adds its answer.
            if source not in existing["sources"]:
                existing["sources"].append(source)
                apply_pdf_answer(db, existing, q["result"] == "correct")
            continue
        new = db["questions"][qid] = {
            "id": qid,
            "text": q["text"],
            "options": q["options"],
            "correct": q["correct"],
            "explanation": q["explanation"],
            "sources": [source],
            "flagged": False,
            "note": "",
            "created": now_iso(),
            "counts": {"right": 0, "wrong": 0},
        }
        start_from_pdfs(db, new)
        new["counts"] = {"right": int(q["result"] == "correct"), "wrong": int(q["result"] == "incorrect")}
    db["tests"][test_id] = {
        "id": test_id,
        "title": parsed["title"],
        "file": parsed["file"],
        "score": parsed["score"],
        "total": parsed["total"],
        "questions": qids,
        "imported": now_iso(),
        "file_mtime": os.path.getmtime(path),
        "warnings": parsed["warnings"],
    }
    return {"file": parsed["file"], "test": parsed["title"], "questions": len(qids),
            "wrong": sum(1 for q in parsed["questions"] if q["result"] == "incorrect"),
            "warnings": parsed["warnings"]}


def scan_folder(db, force=False):
    known = {t["file"]: t for t in db["tests"].values()}
    report = {"imported": [], "skipped": 0, "errors": []}
    for path in sorted(PDF_DIR.glob("*.pdf")):
        t = known.get(path.name)
        if t and not force and t.get("file_mtime") == os.path.getmtime(path):
            report["skipped"] += 1
            continue
        try:
            report["imported"].append(import_pdf(db, path))
        except ParseError as e:
            report["errors"].append({"file": path.name, "error": str(e)})
    return report


# ---------------------------------------------------------------- progress

def exam_date(db):
    value = db.get("settings", {}).get("exam_date")
    return date.fromisoformat(value) if value else None


def start_of(day):
    return datetime.combine(day, datetime.min.time())


def next_count_time(db, stats, now=None):
    """From when a right answer counts again for a question with these stats.

    Not mastered: from the next calendar day after the last counting answer (right
    away if nothing counted since the last miss). With an exam ahead and more steps
    left than study days, SAME_DAY_GAP_HOURS later instead. Mastered: a check after
    CHECK_DAYS, pulled forward to the last study day before an exam.
    Pass `now` when comparing against it, so both sides use the same instant.
    """
    now = now or datetime.now()
    if not stats["last_counted"]:
        return now
    last = datetime.fromisoformat(stats["last_counted"])
    streak = stats["streak"]
    exam = exam_date(db)
    exam_ahead = exam is not None and exam > now.date()
    if streak < MASTERED_STREAK:
        when = start_of(last.date() + timedelta(days=1))
        if exam_ahead:
            # Study days still free after the last counted one (the exam day itself doesn't count).
            free_days = (exam - last.date()).days - 1
            if MASTERED_STREAK - streak > free_days:
                when = min(when, last + timedelta(hours=SAME_DAY_GAP_HOURS))
        return when
    interval = CHECK_DAYS[min(streak - MASTERED_STREAK, len(CHECK_DAYS) - 1)]
    when = start_of(last.date() + timedelta(days=interval))
    if exam_ahead:
        last_study_day = start_of(exam - timedelta(days=1))
        if when > last_study_day:
            when = max(last_study_day, start_of(last.date() + timedelta(days=1)))
    return when


def refresh_due(db, q):
    q["stats"]["due"] = next_count_time(db, q["stats"]).isoformat(timespec="seconds")


def apply_pdf_answer(db, q, correct):
    """A new PDF containing this question: it counts like an answer given on import."""
    q["counts"]["right" if correct else "wrong"] += 1
    q["flags"]["practised"] = True
    if not correct:
        q["flags"]["missed"] = True
        q["stats"].update(streak=0, last_counted=None)
    refresh_due(db, q)


def set_exam_date(db, value):
    settings = db.setdefault("settings", {})
    if value:
        exam = date.fromisoformat(value)
        if exam <= date.today():
            raise ValueError("the exam date must be in the future")
        settings["exam_date"] = exam.isoformat()
    else:
        settings["exam_date"] = None
    for q in db["questions"].values():
        refresh_due(db, q)


def backfill_counts(db):
    """Give every question lifetime right/wrong counters, filled from past quiz sessions.

    Sessions store each question's first answer only, which is exactly what the
    counters count. Runs once; afterwards record_answer keeps them up to date.
    """
    if db.get("counts_backfilled"):
        return False
    for q in db["questions"].values():
        q["counts"] = {"right": 0, "wrong": 0}
    for session in db["sessions"]:
        for a in session.get("answers", []):
            q = db["questions"].get(a["qid"])
            if q:
                q["counts"]["right" if a["ok"] else "wrong"] += 1
    db["counts_backfilled"] = True
    return True


def migrate_v2(db):
    """Convert the version 1 progress model (Leitner box + due date) in place.

    box -> streak; the last right answer (or the import time) -> last_counted; flags
    from PDF results, the answer log and the wrong counter; PDF results are added to
    the counters, which so far only held quiz answers.
    """
    if db.get("version", 1) >= DB_VERSION:
        return False
    for q in db["questions"].values():
        old = q["stats"]
        history = old.get("history", [])
        box = min(old.get("box", 0), MAX_STREAK)
        last_right = next((h["t"] for h in reversed(history) if h["ok"]), None)
        results = pdf_results(q)
        counts = q.setdefault("counts", {"right": 0, "wrong": 0})
        q["flags"] = {
            "practised": bool(results) or old.get("seen", 0) > 0,
            "missed": "incorrect" in results or any(not h["ok"] for h in history) or counts["wrong"] > 0,
        }
        counts["right"] += results.count("correct")
        counts["wrong"] += results.count("incorrect")
        q["stats"] = {
            "streak": box,
            "last_counted": (last_right or q.get("created")) if box else None,
            "due": None,
            "seen": old.get("seen", 0), "right": old.get("right", 0),
            "last_seen": old.get("last_seen"), "history": history,
        }
        refresh_due(db, q)
    db.setdefault("daily", {})
    db["version"] = DB_VERSION
    return True


def log_day(db, **changes):
    day = db.setdefault("daily", {}).setdefault(date.today().isoformat(),
                                                {"answers": 0, "steps": 0, "mastered": 0, "slipped": 0})
    for key, n in changes.items():
        day[key] += n


def record_answer(db, qid, correct, chosen, count=False):
    q = db["questions"].get(qid)
    if not q:
        return None
    if count:
        # Lifetime counters: one per question per quiz session, never reset.
        q["counts"]["right" if correct else "wrong"] += 1
    s = q["stats"]
    before = s["streak"]
    counted = False
    now = datetime.now()
    q["flags"]["practised"] = True
    s["seen"] += 1
    s["last_seen"] = now.isoformat(timespec="seconds")
    if correct:
        s["right"] += 1
        # Answering again the same day proves nothing new: only a later day counts.
        if now >= next_count_time(db, s, now):
            s["streak"] = min(before + 1, MAX_STREAK)
            s["last_counted"] = s["last_seen"]
            counted = True
    else:
        q["flags"]["missed"] = True
        s["streak"] = 0
        s["last_counted"] = None
    refresh_due(db, q)
    s["history"] = (s["history"] + [{"t": s["last_seen"], "ok": correct, "chosen": chosen,
                                     "counted": counted}])[-20:]
    log_day(db, answers=1, steps=int(counted),
            mastered=int(before < MASTERED_STREAK <= s["streak"]),
            slipped=int(not correct and before > 0))
    return q


def reset_progress(db, blank=False):
    """Back to just after import (counters kept), or with blank=True, as if nothing was ever answered."""
    for q in db["questions"].values():
        if blank:
            q["stats"] = new_stats()
            q["flags"] = {"practised": False, "missed": False}
            q["counts"] = {"right": 0, "wrong": 0}
            refresh_due(db, q)
        else:
            start_from_pdfs(db, q)
    db["sessions"] = []
    db["daily"] = {}


def validate_question(body):
    text = str(body.get("text", "")).strip()
    options = [str(o).strip() for o in body.get("options", []) if str(o).strip()]
    correct = sorted({int(i) for i in body.get("correct", []) if 0 <= int(i) < len(options)})
    if not text:
        raise ValueError("question text is required")
    if len(options) < 2:
        raise ValueError("at least two options are required")
    if not correct:
        raise ValueError("mark at least one option as correct")
    return text, options, correct


# ---------------------------------------------------------------- http

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def read_json(self):
        raw = self.read_body()
        return json.loads(raw) if raw else {}

    def route(self, method):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return False
        try:
            with lock:
                self.api(method, path)
        except (ValueError, KeyError) as e:
            self.send_json({"error": str(e)}, 400)
        except Exception as e:  # keep the server alive, show the error in the UI
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)
        return True

    def api(self, method, path):
        db = load_db()
        parts = path.strip("/").split("/")[1:]

        if method == "GET" and parts == ["db"]:
            return self.send_json({**db, "config": {
                "pdf_dir": str(PDF_DIR), "mastered_streak": MASTERED_STREAK, "check_days": CHECK_DAYS}})

        if method == "GET" and parts == ["export"]:
            body = json.dumps(db, indent=1, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Disposition",
                             f'attachment; filename="uk-quiz-backup-{datetime.now():%Y%m%d}.json"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if method == "POST" and parts == ["scan"]:
            force = self.read_json().get("force", False)
            backup_db()
            report = scan_folder(db, force=force)
            save_db(db)
            return self.send_json(report)

        if method == "POST" and parts == ["upload"]:
            name = Path(unquote(self.headers.get("X-Filename", ""))).name
            if not name.lower().endswith(".pdf"):
                raise ValueError("only .pdf files can be uploaded")
            data = self.read_body()
            if not data.startswith(b"%PDF"):
                raise ValueError(f"{name} is not a PDF")
            dest = PDF_DIR / name
            dest.write_bytes(data)
            backup_db()
            try:
                result = import_pdf(db, dest)
            except ParseError as e:
                dest.unlink()
                raise ValueError(f"{name}: {e}")
            save_db(db)
            return self.send_json(result)

        if method == "POST" and parts == ["answer"]:
            body = self.read_json()
            q = record_answer(db, body["qid"], bool(body["correct"]), body.get("chosen", []),
                              count=bool(body.get("count")))
            if not q:
                raise ValueError("unknown question")
            save_db(db)
            return self.send_json(q)

        if method == "POST" and parts == ["session"]:
            body = self.read_json()
            session = {
                "id": hashlib.sha1(f"{time.time()}".encode()).hexdigest()[:10],
                "mode": body.get("mode"), "label": body.get("label"),
                "started": body.get("started"), "finished": now_iso(),
                "seconds": body.get("seconds"),
                "score": body.get("score"), "total": body.get("total"),
                "answers": body.get("answers", []),
            }
            db["sessions"].append(session)
            save_db(db)
            return self.send_json(session)

        if method == "POST" and parts == ["question"]:
            text, options, correct = validate_question(self.read_json())
            qid = question_id(text, options)
            if qid in db["questions"]:
                raise ValueError("this question already exists")
            db["questions"][qid] = {
                "id": qid, "text": text, "options": options, "correct": correct,
                "explanation": "", "sources": [{"test": "manual", "result": "manual"}],
                "flagged": False, "note": "", "created": now_iso(),
                "counts": {"right": 0, "wrong": 0},
            }
            start_from_pdfs(db, db["questions"][qid])
            save_db(db)
            return self.send_json(db["questions"][qid])

        if len(parts) == 2 and parts[0] == "question":
            qid = parts[1]
            q = db["questions"].get(qid)
            if not q:
                raise ValueError("unknown question")
            if method == "PATCH":
                body = self.read_json()
                if "options" in body or "text" in body or "correct" in body:
                    text, options, correct = validate_question({**q, **body})
                    q.update(text=text, options=options, correct=correct)
                for key in ("explanation", "note"):
                    if key in body:
                        q[key] = str(body[key])
                if "flagged" in body:
                    q["flagged"] = bool(body["flagged"])
                if body.get("reset_stats"):
                    start_from_pdfs(db, q)
                save_db(db)
                return self.send_json(q)
            if method == "DELETE":
                backup_db()
                del db["questions"][qid]
                for t in db["tests"].values():
                    if qid in t["questions"]:
                        t["questions"].remove(qid)
                save_db(db)
                return self.send_json({"ok": True})

        if method == "PATCH" and parts == ["settings"]:
            body = self.read_json()
            if "exam_date" in body:
                set_exam_date(db, body["exam_date"])
            if "exam_prompt_dismissed" in body:
                db.setdefault("settings", {})["exam_prompt_dismissed"] = bool(body["exam_prompt_dismissed"])
            save_db(db)
            return self.send_json(db["settings"])

        if method == "POST" and parts == ["reset-progress"]:
            backup_db()
            reset_progress(db, blank=bool(self.read_json().get("blank")))
            save_db(db)
            return self.send_json({"ok": True})

        self.send_json({"error": "not found"}, 404)

    def do_GET(self):
        if not self.route("GET"):
            super().do_GET()

    def do_POST(self):
        self.route("POST")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")


def main():
    global PDF_DIR
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--pdf-dir", default=str(DEFAULT_PDF_DIR), help="folder with the test PDFs (default: pdfs/ next to server.py)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    PDF_DIR = Path(args.pdf_dir).expanduser().resolve()
    PDF_DIR.mkdir(parents=True, exist_ok=True)

    with lock:
        db = load_db()
        # Order matters: quiz counters first, then the model conversion, then new PDFs
        # (which are imported straight into the new model).
        migrated = backfill_counts(db)
        migrated = migrate_v2(db) or migrated
        if migrated and DB_PATH.exists():
            backup_db()
        report = scan_folder(db)
        if report["imported"] or migrated or not DB_PATH.exists():
            backup_db()
            save_db(db)
    for r in report["imported"]:
        print(f"imported {r['file']}: {r['questions']} questions, {r['wrong']} wrong"
              + (f"  WARNING: {'; '.join(r['warnings'])}" if r["warnings"] else ""))
    for e in report["errors"]:
        print(f"could not import {e['file']}: {e['error']}")

    url = f"http://127.0.0.1:{args.port}/"
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"UK quiz running at {url}  (PDF folder: {PDF_DIR})  - Ctrl+C to stop")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
