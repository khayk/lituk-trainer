"""Import, spaced repetition, exam-date scheduling and counters (server.py logic, no HTTP)."""

import os
import unittest
from datetime import datetime, timedelta

import server
from pdf_parser import ParseError
from tests.helpers import FakeParser, FrozenClock, TempData, parsed, question, write_pdfs

M = server.MASTERED_BOX
CAPITAL = question("What is the capital of Testland?", ["Alpha", "Beta", "Gamma"], [1])
RIVER = question("Which river is longest?", ["North", "South"], [0], result="incorrect")
COLOUR = question("Which colour is invented?", ["Red", "Glimmer"], [1])


def qid_of(q):
    return server.question_id(q["text"], q["options"])


class QuestionIdTest(unittest.TestCase):
    def test_ignores_case_punctuation_and_option_order(self):
        a = server.question_id("What is the capital?", ["Alpha", "Beta"])
        b = server.question_id("what is the CAPITAL", ["beta", "alpha."])
        self.assertEqual(a, b)

    def test_different_options_are_a_different_question(self):
        a = server.question_id("What is the capital?", ["Alpha", "Beta"])
        b = server.question_id("What is the capital?", ["Alpha", "Gamma"])
        self.assertNotEqual(a, b)


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TempData().__enter__()
        self.db = server.empty_db()

    def tearDown(self):
        self.tmp.__exit__()

    def import_tests(self, *results):
        write_pdfs(self.tmp.pdfs, results)
        with FakeParser(results):
            return server.scan_folder(self.db)

    def test_new_questions_start_in_box_by_test_result(self):
        self.import_tests(parsed("test-1", [CAPITAL, RIVER]))
        self.assertEqual(self.db["questions"][qid_of(CAPITAL)]["stats"]["box"], 1)
        self.assertEqual(self.db["questions"][qid_of(RIVER)]["stats"]["box"], 0)
        self.assertEqual(self.db["questions"][qid_of(RIVER)]["counts"], {"right": 0, "wrong": 0})
        test = self.db["tests"]["test-1"]
        self.assertEqual((test["score"], test["total"], len(test["questions"])), (1, 2, 2))

    def test_same_question_in_two_tests_is_merged(self):
        self.import_tests(parsed("test-1", [CAPITAL]), parsed("test-2", [CAPITAL, COLOUR]))
        self.assertEqual(len(self.db["questions"]), 2)
        self.assertEqual([s["test"] for s in self.db["questions"][qid_of(CAPITAL)]["sources"]], ["test-1", "test-2"])

    def test_new_mistake_in_another_test_resets_progress(self):
        self.import_tests(parsed("test-1", [CAPITAL]))
        self.db["questions"][qid_of(CAPITAL)]["stats"]["box"] = 2
        self.import_tests(parsed("test-2", [{**CAPITAL, "result": "incorrect"}]))
        self.assertEqual(self.db["questions"][qid_of(CAPITAL)]["stats"]["box"], 0)

    def test_reimporting_a_test_keeps_progress(self):
        result = parsed("test-1", [RIVER])
        self.import_tests(result)
        self.db["questions"][qid_of(RIVER)]["stats"]["box"] = 2  # learned since
        write_pdfs(self.tmp.pdfs, [result])
        with FakeParser([result]):
            server.scan_folder(self.db, force=True)
        self.assertEqual(self.db["questions"][qid_of(RIVER)]["stats"]["box"], 2)
        self.assertEqual(len(self.db["questions"][qid_of(RIVER)]["sources"]), 1)

    def test_scan_skips_unchanged_files(self):
        result = parsed("test-1", [CAPITAL])
        self.assertEqual(len(self.import_tests(result)["imported"]), 1)
        with FakeParser([result]):
            report = server.scan_folder(self.db)
        self.assertEqual((report["imported"], report["skipped"]), ([], 1))

    def test_renamed_file_updates_the_same_test(self):
        self.import_tests(parsed("test-1", [CAPITAL], file="test-01-0e.pdf"))
        os.remove(self.tmp.pdfs / "test-01-0e.pdf")
        self.import_tests(parsed("test-1", [CAPITAL], file="test-1-0e.pdf"))
        self.assertEqual(list(self.db["tests"]), ["test-1"])
        self.assertEqual(self.db["tests"]["test-1"]["file"], "test-1-0e.pdf")

    def test_unreadable_pdf_is_reported_not_fatal(self):
        (self.tmp.pdfs / "broken.pdf").write_bytes(b"%PDF")

        def fail(path):
            raise ParseError("no questions found")

        saved, server.parse_pdf = server.parse_pdf, fail
        try:
            report = server.scan_folder(self.db)
        finally:
            server.parse_pdf = saved
        self.assertEqual(report["errors"], [{"file": "broken.pdf", "error": "no questions found"}])


class SpacedRepetitionTest(unittest.TestCase):
    def setUp(self):
        self.clock = FrozenClock(datetime(2026, 10, 1, 9, 0)).__enter__()
        self.db = server.empty_db()
        self.db["questions"]["q"] = {"stats": server.new_stats(box=0), "counts": {"right": 0, "wrong": 0}}
        self.s = self.db["questions"]["q"]["stats"]

    def tearDown(self):
        self.clock.__exit__()

    def answer(self, ok, count=False):
        return server.record_answer(self.db, "q", ok, [], count=count)

    def test_right_answer_when_due_moves_up_one_box(self):
        self.answer(True)
        self.assertEqual(self.s["box"], 1)
        self.assertEqual(datetime.fromisoformat(self.s["due"]), self.clock.when + timedelta(days=1))

    def test_answering_again_before_due_does_not_move_up(self):
        self.answer(True)
        self.answer(True)
        self.answer(True)
        self.assertEqual(self.s["box"], 1)
        self.assertEqual((self.s["seen"], self.s["right"]), (3, 3))

    def test_mastery_takes_three_spaced_days(self):
        for days_later in (0, 1, 2):
            self.clock.advance(days=days_later)
            self.answer(True)
        self.assertEqual(self.s["box"], M)

    def test_wrong_answer_resets_and_is_due_now(self):
        self.s.update(box=4, streak=4)
        self.answer(False)
        self.assertEqual((self.s["box"], self.s["streak"]), (0, 0))
        self.assertLessEqual(datetime.fromisoformat(self.s["due"]), self.clock.when)

    def test_second_chance_in_same_session_counts_as_first_step(self):
        self.answer(False)
        self.answer(True)
        self.assertEqual(self.s["box"], 1)

    def test_history_keeps_last_twenty_answers(self):
        for _ in range(25):
            self.answer(False)
        self.assertEqual(len(self.s["history"]), 20)

    def test_unknown_question_returns_none(self):
        self.assertIsNone(server.record_answer(self.db, "nope", True, []))


class CountersTest(unittest.TestCase):
    def setUp(self):
        self.db = server.empty_db()
        self.db["questions"]["q"] = {"stats": server.new_stats(), "counts": {"right": 0, "wrong": 0}}

    def test_only_counted_answers_change_counters(self):
        server.record_answer(self.db, "q", False, [], count=True)
        server.record_answer(self.db, "q", True, [], count=False)  # second chance in the same quiz
        server.record_answer(self.db, "q", True, [], count=True)
        self.assertEqual(self.db["questions"]["q"]["counts"], {"right": 1, "wrong": 1})

    def test_counters_created_for_old_questions(self):
        del self.db["questions"]["q"]["counts"]
        server.record_answer(self.db, "q", True, [], count=True)
        self.assertEqual(self.db["questions"]["q"]["counts"], {"right": 1, "wrong": 0})

    def test_backfill_from_sessions_runs_once(self):
        self.db["sessions"] = [{"answers": [{"qid": "q", "ok": True}, {"qid": "gone", "ok": False}]},
                               {"answers": [{"qid": "q", "ok": False}]}]
        self.assertTrue(server.backfill_counts(self.db))
        self.assertEqual(self.db["questions"]["q"]["counts"], {"right": 1, "wrong": 1})
        self.db["questions"]["q"]["counts"]["right"] = 7
        self.assertFalse(server.backfill_counts(self.db))
        self.assertEqual(self.db["questions"]["q"]["counts"]["right"], 7)


class ExamPlanTest(unittest.TestCase):
    TODAY = datetime(2026, 10, 25, 9, 0)

    def setUp(self):
        self.clock = FrozenClock(self.TODAY).__enter__()
        self.db = server.empty_db()

    def tearDown(self):
        self.clock.__exit__()

    def study_until_mastered(self, start_box, exam_in_days, session_every_hours=12):
        """Answer right whenever due; return the day it was mastered or None."""
        self.db["questions"] = {"q": {"stats": server.new_stats(box=start_box)}}
        exam = (self.TODAY + timedelta(days=exam_in_days)).date()
        server.set_exam_date(self.db, exam.isoformat())
        s = self.db["questions"]["q"]["stats"]
        while self.clock.when.date() < exam:
            due = s["due"] and datetime.fromisoformat(s["due"])
            if not due or due <= self.clock.when:
                server.record_answer(self.db, "q", True, [])
                if s["box"] >= M:
                    return self.clock.when.date()
            self.clock.advance(hours=session_every_hours)
        return None

    def test_mistake_mastered_before_exam_in_four_days(self):
        mastered = self.study_until_mastered(start_box=0, exam_in_days=4)
        self.assertIsNotNone(mastered)
        self.assertLess(mastered, (self.TODAY + timedelta(days=4)).date())

    def test_question_right_in_pdf_mastered_before_exam(self):
        self.assertIsNotNone(self.study_until_mastered(start_box=1, exam_in_days=4))

    def test_steps_squeezed_into_hours_when_days_run_out(self):
        self.assertIsNotNone(self.study_until_mastered(start_box=0, exam_in_days=1, session_every_hours=3))

    def test_without_exam_uses_standard_intervals(self):
        self.assertEqual(server.next_due(self.db, 2), self.TODAY + timedelta(days=server.BOX_INTERVAL_DAYS[2]))

    def test_past_exam_falls_back_to_standard_intervals(self):
        self.db["settings"] = {"exam_date": "2026-10-20"}
        self.assertEqual(server.next_due(self.db, 2), self.TODAY + timedelta(days=server.BOX_INTERVAL_DAYS[2]))

    def test_mastered_question_gets_a_check_before_exam(self):
        self.db["settings"] = {"exam_date": "2026-10-29"}
        due = server.next_due(self.db, 4)  # normally 8 days away
        self.assertLess(due.date(), datetime(2026, 10, 29).date())

    def test_setting_date_pulls_later_reviews_before_exam(self):
        later = (self.TODAY + timedelta(days=20)).isoformat()
        self.db["questions"] = {"q": {"stats": {**server.new_stats(box=5), "due": later}}}
        server.set_exam_date(self.db, "2026-10-29")
        self.assertEqual(self.db["questions"]["q"]["stats"]["due"], "2026-10-28T00:00:00")

    def test_rejects_today_or_past_dates(self):
        for value in ("2026-10-25", "2026-01-01"):
            with self.assertRaises(ValueError):
                server.set_exam_date(self.db, value)

    def test_clearing_the_date(self):
        server.set_exam_date(self.db, "2026-10-29")
        server.set_exam_date(self.db, None)
        self.assertIsNone(server.exam_date(self.db))


class ValidateQuestionTest(unittest.TestCase):
    def test_cleans_input(self):
        text, options, correct = server.validate_question(
            {"text": "  Q?  ", "options": ["a", " ", "b"], "correct": [1, 1, 5]})
        self.assertEqual((text, options, correct), ("Q?", ["a", "b"], [1]))

    def test_rejects_incomplete_questions(self):
        for body in ({"text": "", "options": ["a", "b"], "correct": [0]},
                     {"text": "Q", "options": ["a"], "correct": [0]},
                     {"text": "Q", "options": ["a", "b"], "correct": []}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                server.validate_question(body)


if __name__ == "__main__":
    unittest.main()
