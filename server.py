#!/usr/bin/env python3
"""Local Life in the UK quiz app.

    python3 server.py              # serves http://127.0.0.1:8765, PDFs from ../
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
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote

from pdf_parser import ParseError, parse_pdf

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = APP_DIR / "data"
DB_PATH = DATA_DIR / "db.json"

# Leitner boxes: a correct answer moves a question up one box, a wrong answer
# sends it back to box 0. The box decides when it is due again.
BOX_INTERVAL_DAYS = [0, 1, 2, 4, 8, 16, 32]
MASTERED_BOX = 3

lock = threading.Lock()
PDF_DIR = APP_DIR.parent


# ---------------------------------------------------------------- storage

def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def empty_db():
    return {"version": 1, "tests": {}, "questions": {}, "sessions": []}


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


def new_stats(box=0):
    return {"seen": 0, "right": 0, "streak": 0, "box": box, "last_seen": None,
            "due": None, "history": []}


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
            if source not in existing["sources"]:
                existing["sources"].append(source)
            if q["result"] == "incorrect":
                existing["stats"]["box"] = 0
                existing["stats"]["due"] = None
            continue
        db["questions"][qid] = {
            "id": qid,
            "text": q["text"],
            "options": q["options"],
            "correct": q["correct"],
            "explanation": q["explanation"],
            "sources": [source],
            "flagged": False,
            "note": "",
            "created": now_iso(),
            # Answered correctly in the real test -> already one step up.
            "stats": new_stats(box=1 if q["result"] == "correct" else 0),
        }
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

def record_answer(db, qid, correct, chosen):
    q = db["questions"].get(qid)
    if not q:
        return None
    s = q["stats"]
    s["seen"] += 1
    s["last_seen"] = now_iso()
    if correct:
        s["right"] += 1
        s["streak"] += 1
        s["box"] = min(s["box"] + 1, len(BOX_INTERVAL_DAYS) - 1)
    else:
        s["streak"] = 0
        s["box"] = 0
    s["due"] = (datetime.now() + timedelta(days=BOX_INTERVAL_DAYS[s["box"]])).isoformat(timespec="seconds")
    s["history"] = (s["history"] + [{"t": s["last_seen"], "ok": correct, "chosen": chosen}])[-20:]
    return q


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
                "pdf_dir": str(PDF_DIR), "box_interval_days": BOX_INTERVAL_DAYS,
                "mastered_box": MASTERED_BOX}})

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
            q = record_answer(db, body["qid"], bool(body["correct"]), body.get("chosen", []))
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
                "flagged": False, "note": "", "created": now_iso(), "stats": new_stats(),
            }
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
                    q["stats"] = new_stats()
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

        if method == "POST" and parts == ["reset-progress"]:
            backup_db()
            for q in db["questions"].values():
                box = 0 if any(s["result"] == "incorrect" for s in q["sources"]) else 1
                q["stats"] = new_stats(box=box)
            db["sessions"] = []
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
    ap.add_argument("--pdf-dir", default=str(APP_DIR.parent), help="folder with the test PDFs")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    PDF_DIR = Path(args.pdf_dir).expanduser().resolve()

    with lock:
        db = load_db()
        report = scan_folder(db)
        if report["imported"] or not DB_PATH.exists():
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
