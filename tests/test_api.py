"""The HTTP API, end to end against a real server on a random port and a temporary data folder."""

import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import server
from tests.helpers import FakeParser, TempData, parsed, question, write_pdfs

CAPITAL = question("What is the capital of Testland?", ["Alpha", "Beta", "Gamma"], [1], result="incorrect")
COLOUR = question("Which colour is invented?", ["Red", "Glimmer"], [1])


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TempData().__enter__()
        self.results = [parsed("test-1", [CAPITAL, COLOUR], file="test-1-1e.pdf")]
        write_pdfs(self.tmp.pdfs, self.results)
        self.parser = FakeParser(self.results).__enter__()
        db = server.empty_db()
        server.scan_folder(db)
        server.save_db(db)
        self.qid = server.question_id(CAPITAL["text"], CAPITAL["options"])

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.parser.__exit__()
        self.tmp.__exit__()

    def call(self, method, path, body=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as res:
                payload = res.read()
                return res.status, json.loads(payload) if res.headers.get_content_type() == "application/json" else payload
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def db(self):
        return self.call("GET", "/api/db")[1]

    def test_serves_the_app(self):
        status, page = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<title>", page)

    def test_db_has_questions_tests_and_config(self):
        db = self.db()
        self.assertEqual(len(db["questions"]), 2)
        self.assertIn("test-1", db["tests"])
        self.assertEqual(db["config"]["mastered_box"], server.MASTERED_BOX)

    def test_answer_updates_progress_and_counters(self):
        status, q = self.call("POST", "/api/answer", {"qid": self.qid, "correct": True, "chosen": [1], "count": True})
        self.assertEqual(status, 200)
        self.assertEqual((q["stats"]["box"], q["counts"]), (1, {"right": 1, "wrong": 0}))
        self.assertEqual(self.db()["questions"][self.qid]["stats"]["box"], 1, "saved to disk")

    def test_answer_without_count_flag_leaves_counters(self):
        _, q = self.call("POST", "/api/answer", {"qid": self.qid, "correct": False, "chosen": [0]})
        self.assertEqual(q["counts"], {"right": 0, "wrong": 0})

    def test_answer_to_unknown_question_is_rejected(self):
        self.assertEqual(self.call("POST", "/api/answer", {"qid": "nope", "correct": True})[0], 400)

    def test_flag_note_and_edit_question(self):
        _, q = self.call("PATCH", f"/api/question/{self.qid}", {"flagged": True, "note": "remember Beta"})
        self.assertEqual((q["flagged"], q["note"]), (True, "remember Beta"))
        _, q = self.call("PATCH", f"/api/question/{self.qid}", {"options": ["Alpha", "Beta", "Delta"], "correct": [2]})
        self.assertEqual((q["options"][2], q["correct"]), ("Delta", [2]))

    def test_invalid_edit_is_rejected(self):
        status, body = self.call("PATCH", f"/api/question/{self.qid}", {"correct": []})
        self.assertEqual(status, 400)
        self.assertIn("correct", body["error"])

    def test_add_and_delete_question(self):
        new = {"text": "Is this a test?", "options": ["Yes", "No"], "correct": [0]}
        status, q = self.call("POST", "/api/question", new)
        self.assertEqual(status, 200)
        self.assertEqual(self.call("POST", "/api/question", new)[0], 400, "duplicate")
        self.assertEqual(self.call("DELETE", f"/api/question/{q['id']}")[0], 200)
        self.assertNotIn(q["id"], self.db()["questions"])

    def test_reset_stats_of_one_question_keeps_counters(self):
        self.call("POST", "/api/answer", {"qid": self.qid, "correct": True, "chosen": [1], "count": True})
        _, q = self.call("PATCH", f"/api/question/{self.qid}", {"reset_stats": True})
        self.assertEqual((q["stats"]["seen"], q["counts"]["right"]), (0, 1))

    def test_reset_all_progress_keeps_counters_and_questions(self):
        self.call("POST", "/api/answer", {"qid": self.qid, "correct": True, "chosen": [1], "count": True})
        self.call("POST", "/api/session", {"mode": "fix", "score": 1, "total": 1, "answers": []})
        self.assertEqual(self.call("POST", "/api/reset-progress")[0], 200)
        db = self.db()
        self.assertEqual(db["sessions"], [])
        q = db["questions"][self.qid]
        self.assertEqual((q["stats"]["box"], q["counts"]["right"]), (0, 1))  # back to box 0: wrong in the test

    def test_session_is_recorded(self):
        _, s = self.call("POST", "/api/session", {"mode": "exam", "label": "Mock exam", "score": 20, "total": 24,
                                                  "answers": [{"qid": self.qid, "ok": True, "chosen": [1]}]})
        self.assertEqual(self.db()["sessions"][-1]["id"], s["id"])

    def test_exam_date_settings(self):
        status, settings = self.call("PATCH", "/api/settings", {"exam_date": "2099-01-01"})
        self.assertEqual((status, settings["exam_date"]), (200, "2099-01-01"))
        self.assertEqual(self.call("PATCH", "/api/settings", {"exam_date": "2000-01-01"})[0], 400)
        self.assertEqual(self.call("PATCH", "/api/settings", {"exam_date": "not a date"})[0], 400)
        _, settings = self.call("PATCH", "/api/settings", {"exam_date": None, "exam_prompt_dismissed": True})
        self.assertEqual((settings["exam_date"], settings["exam_prompt_dismissed"]), (None, True))

    def test_upload_imports_a_pdf(self):
        self.parser.results["test-2-0e.pdf"] = parsed("test-2", [COLOUR], file="test-2-0e.pdf")
        status, r = self.call("POST", "/api/upload", raw=b"%PDF-1.4 upload", headers={"X-Filename": "test-2-0e.pdf"})
        self.assertEqual((status, r["questions"]), (200, 1))
        self.assertTrue((self.tmp.pdfs / "test-2-0e.pdf").exists())
        self.assertIn("test-2", self.db()["tests"])

    def test_upload_rejects_non_pdfs(self):
        self.assertEqual(self.call("POST", "/api/upload", raw=b"%PDF", headers={"X-Filename": "notes.txt"})[0], 400)
        self.assertEqual(self.call("POST", "/api/upload", raw=b"hello", headers={"X-Filename": "fake.pdf"})[0], 400)

    def test_upload_cannot_escape_the_pdf_folder(self):
        self.parser.results["evil.pdf"] = parsed("evil", [COLOUR], file="evil.pdf")
        self.call("POST", "/api/upload", raw=b"%PDF-1.4", headers={"X-Filename": "../../evil.pdf"})
        self.assertFalse((self.tmp.root / "evil.pdf").exists())
        self.assertTrue((self.tmp.pdfs / "evil.pdf").exists())

    def test_rescan_reports_unchanged_files(self):
        _, report = self.call("POST", "/api/scan", {})
        self.assertEqual((report["imported"], report["skipped"]), ([], 1))

    def test_export_downloads_the_database(self):
        with urllib.request.urlopen(self.base + "/api/export") as res:
            self.assertIn("attachment", res.headers["Content-Disposition"])
            self.assertIn("questions", json.loads(res.read()))

    def test_changes_are_backed_up(self):
        self.call("POST", "/api/reset-progress")
        self.assertTrue(list((server.DATA_DIR / "backups").glob("db-*.json")))

    def test_unknown_endpoint(self):
        self.assertEqual(self.call("GET", "/api/nothing")[0], 404)


if __name__ == "__main__":
    unittest.main()
