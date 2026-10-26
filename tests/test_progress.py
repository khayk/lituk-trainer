"""Import, the streak model, exam-date scheduling, counters, migration and resets (server.py, no HTTP)."""

import copy
import os
import unittest
from datetime import datetime, timedelta

import server
from pdf_parser import ParseError
from tests.helpers import FakeParser, FrozenClock, TempData, parsed, question, write_pdfs

M = server.MASTERED_STREAK
CAPITAL = question("What is the capital of Testland?", ["Alpha", "Beta", "Gamma"], [1])
RIVER = question("Which river is longest?", ["North", "South"], [0], result="incorrect")
COLOUR = question("Which colour is invented?", ["Red", "Glimmer"], [1])


def qid_of(q):
    return server.question_id(q["text"], q["options"])


def bare_question(streak=0, last_counted=None, practised=True, missed=False, sources=()):
    return {"id": "q", "sources": list(sources), "created": "2026-10-01T09:00:00",
            "stats": server.new_stats(streak, last_counted),
            "flags": {"practised": practised, "missed": missed}, "counts": {"right": 0, "wrong": 0}}


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

    def q(self, question_):
        return self.db["questions"][qid_of(question_)]

    def test_right_in_pdf_starts_at_step_one(self):
        self.import_tests(parsed("test-1", [CAPITAL]))
        q = self.q(CAPITAL)
        self.assertEqual(q["stats"]["streak"], 1)
        self.assertIsNotNone(q["stats"]["last_counted"])
        self.assertEqual(q["flags"], {"practised": True, "missed": False})
        self.assertEqual(q["counts"], {"right": 1, "wrong": 0})

    def test_wrong_in_pdf_starts_at_step_zero_and_is_marked(self):
        self.import_tests(parsed("test-1", [RIVER]))
        q = self.q(RIVER)
        self.assertEqual((q["stats"]["streak"], q["stats"]["last_counted"]), (0, None))
        self.assertEqual(q["flags"], {"practised": True, "missed": True})
        self.assertEqual(q["counts"], {"right": 0, "wrong": 1})

    def test_same_question_in_two_tests_is_merged_and_counted_twice(self):
        self.import_tests(parsed("test-1", [CAPITAL]), parsed("test-2", [CAPITAL, COLOUR]))
        self.assertEqual(len(self.db["questions"]), 2)
        self.assertEqual([s["test"] for s in self.q(CAPITAL)["sources"]], ["test-1", "test-2"])
        self.assertEqual(self.q(CAPITAL)["counts"], {"right": 2, "wrong": 0})

    def test_new_mistake_in_another_test_resets_streak_and_marks(self):
        self.import_tests(parsed("test-1", [CAPITAL]))
        self.q(CAPITAL)["stats"]["streak"] = 2
        self.import_tests(parsed("test-2", [{**CAPITAL, "result": "incorrect"}]))
        q = self.q(CAPITAL)
        self.assertEqual((q["stats"]["streak"], q["flags"]["missed"]), (0, True))
        self.assertEqual(q["counts"], {"right": 1, "wrong": 1})

    def test_reimporting_a_test_changes_nothing(self):
        result = parsed("test-1", [RIVER])
        self.import_tests(result)
        self.q(RIVER)["stats"]["streak"] = 2  # learned since
        write_pdfs(self.tmp.pdfs, [result])
        with FakeParser([result]):
            server.scan_folder(self.db, force=True)
        q = self.q(RIVER)
        self.assertEqual(q["stats"]["streak"], 2)
        self.assertEqual(q["counts"], {"right": 0, "wrong": 1})
        self.assertEqual(len(q["sources"]), 1)

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


class StreakTest(unittest.TestCase):
    """A right answer counts once per calendar day; a wrong one resets the streak."""

    def setUp(self):
        self.clock = FrozenClock(datetime(2026, 10, 1, 9, 0)).__enter__()
        self.db = server.empty_db()
        self.db["questions"]["q"] = bare_question(practised=False)
        self.q = self.db["questions"]["q"]
        self.s = self.q["stats"]

    def tearDown(self):
        self.clock.__exit__()

    def answer(self, ok, count=False):
        server.record_answer(self.db, "q", ok, [], count=count)
        return self.s["history"][-1]["counted"]

    def test_first_right_answer_counts_and_marks_practised(self):
        self.assertTrue(self.answer(True))
        self.assertEqual(self.s["streak"], 1)
        self.assertTrue(self.q["flags"]["practised"])

    def test_same_day_answers_do_not_count_again(self):
        self.answer(True)
        self.clock.advance(hours=10)
        self.assertFalse(self.answer(True))
        self.assertEqual((self.s["streak"], self.s["seen"], self.s["right"]), (1, 2, 2))

    def test_next_calendar_day_counts_even_a_few_hours_later(self):
        self.clock.when = datetime(2026, 10, 1, 23, 0)
        self.answer(True)
        self.clock.when = datetime(2026, 10, 2, 7, 0)
        self.assertTrue(self.answer(True))
        self.assertEqual(self.s["streak"], 2)

    def test_extra_practice_does_not_delay_the_next_step(self):
        self.answer(True)                       # Thu 09:00 counts
        self.clock.advance(hours=12)
        self.answer(True)                       # Thu 21:00 doesn't count
        self.clock.advance(hours=11)            # Fri 08:00
        self.assertTrue(self.answer(True))

    def test_mastered_after_three_separate_days(self):
        for _ in range(M):
            self.answer(True)
            self.clock.advance(days=1)
        self.assertEqual(self.s["streak"], M)

    def test_wrong_answer_resets_streak_and_marks_missed(self):
        self.s.update(streak=M + 1, last_counted="2026-09-20T09:00:00")
        self.answer(False)
        self.assertEqual((self.s["streak"], self.s["last_counted"]), (0, None))
        self.assertTrue(self.q["flags"]["missed"])
        self.assertLessEqual(datetime.fromisoformat(self.s["due"]), self.clock.when)

    def test_missed_mark_is_permanent(self):
        self.answer(False)
        for _ in range(M + 1):
            self.answer(True)
            self.clock.advance(days=1)
        self.assertTrue(self.q["flags"]["missed"])
        self.assertGreaterEqual(self.s["streak"], M)

    def test_second_chance_after_a_miss_counts_as_first_step(self):
        self.answer(False)
        self.assertTrue(self.answer(True))
        self.assertEqual(self.s["streak"], 1)

    def test_mastered_question_waits_for_its_check(self):
        self.s.update(streak=M, last_counted=self.clock.when.isoformat())
        self.clock.advance(days=server.CHECK_DAYS[0] - 1)
        self.assertFalse(self.answer(True))
        self.clock.advance(days=1)
        self.assertTrue(self.answer(True))
        self.assertEqual(self.s["streak"], M + 1)

    def test_streak_is_capped(self):
        self.s.update(streak=server.MAX_STREAK, last_counted="2026-01-01T00:00:00")
        self.answer(True)
        self.assertEqual(self.s["streak"], server.MAX_STREAK)

    def test_history_keeps_last_twenty_answers(self):
        for _ in range(25):
            self.answer(False)
        self.assertEqual(len(self.s["history"]), 20)

    def test_unknown_question_returns_none(self):
        self.assertIsNone(server.record_answer(self.db, "nope", True, []))


class RealClockTest(unittest.TestCase):
    """Without a frozen clock: "now" must not move between reading it and comparing against it."""

    def test_right_answer_after_a_miss_counts_with_the_real_clock(self):
        db = server.empty_db()
        db["questions"]["q"] = bare_question()
        for _ in range(50):  # the old bug only showed when the clock ticked in between
            server.record_answer(db, "q", False, [])
            server.record_answer(db, "q", True, [])
            self.assertEqual(db["questions"]["q"]["stats"]["streak"], 1)


class DailyLogTest(unittest.TestCase):
    def setUp(self):
        self.clock = FrozenClock(datetime(2026, 10, 1, 9, 0)).__enter__()
        self.db = server.empty_db()
        self.db["questions"] = {"a": {**bare_question(streak=2, last_counted="2026-09-30T09:00:00"), "id": "a"},
                                "b": {**bare_question(streak=1, last_counted="2026-09-30T09:00:00"), "id": "b"}}

    def tearDown(self):
        self.clock.__exit__()

    def test_counts_steps_mastered_and_slipped_per_day(self):
        server.record_answer(self.db, "a", True, [])    # step 2 -> mastered
        server.record_answer(self.db, "a", True, [])    # same day: not a step
        server.record_answer(self.db, "b", False, [])   # slipped from step 1
        self.assertEqual(self.db["daily"]["2026-10-01"], {"answers": 3, "steps": 1, "mastered": 1, "slipped": 1})


class CountersTest(unittest.TestCase):
    def setUp(self):
        self.db = server.empty_db()
        self.db["questions"]["q"] = bare_question()

    def test_only_counted_answers_change_counters(self):
        server.record_answer(self.db, "q", False, [], count=True)
        server.record_answer(self.db, "q", True, [], count=False)  # second chance in the same quiz
        server.record_answer(self.db, "q", True, [], count=True)
        self.assertEqual(self.db["questions"]["q"]["counts"], {"right": 1, "wrong": 1})

    def test_backfill_from_sessions_runs_once(self):
        db = {"questions": {"q": bare_question()},
              "sessions": [{"answers": [{"qid": "q", "ok": True}, {"qid": "gone", "ok": False}]},
                           {"answers": [{"qid": "q", "ok": False}]}]}
        self.assertTrue(server.backfill_counts(db))
        self.assertEqual(db["questions"]["q"]["counts"], {"right": 1, "wrong": 1})
        db["questions"]["q"]["counts"]["right"] = 7
        self.assertFalse(server.backfill_counts(db))
        self.assertEqual(db["questions"]["q"]["counts"]["right"], 7)

    def test_new_databases_are_never_backfilled(self):
        self.assertFalse(server.backfill_counts(server.empty_db()))


class MigrationTest(unittest.TestCase):
    """Version 1 (Leitner box + due date) -> version 2, keeping progress."""

    def v1_question(self, box, history, sources, counts, seen=None):
        return {"id": "q", "created": "2026-10-21T21:50:00", "sources": sources,
                "counts": counts, "stats": {"seen": len(history) if seen is None else seen, "right": 0, "streak": 0,
                                            "box": box, "last_seen": None, "due": None, "history": history}}

    def migrate(self, q):
        db = {"version": 1, "counts_backfilled": True, "questions": {"q": q}, "sessions": [], "tests": {}}
        with FrozenClock(datetime(2026, 10, 26, 9, 0)):
            self.assertTrue(server.migrate_v2(db))
            self.assertFalse(server.migrate_v2(db), "runs once")
        self.assertEqual(db["version"], server.DB_VERSION)
        return db["questions"]["q"]

    def test_pdf_only_question_keeps_its_step(self):
        q = self.migrate(self.v1_question(1, [], [{"test": "test-1", "result": "correct"}], {"right": 0, "wrong": 0}))
        self.assertEqual(q["stats"]["streak"], 1)
        self.assertEqual(q["stats"]["last_counted"], "2026-10-21T21:50:00")  # the import
        self.assertEqual(q["flags"], {"practised": True, "missed": False})
        self.assertEqual(q["counts"], {"right": 1, "wrong": 0})  # the PDF answer is added

    def test_practised_mistake_keeps_step_mark_and_counts(self):
        history = [{"t": "2026-10-24T10:00:00", "ok": False}, {"t": "2026-10-25T10:00:00", "ok": True}]
        q = self.migrate(self.v1_question(2, history, [{"test": "test-1", "result": "incorrect"}],
                                          {"right": 3, "wrong": 1}))
        self.assertEqual(q["stats"]["streak"], 2)
        self.assertEqual(q["stats"]["last_counted"], "2026-10-25T10:00:00")  # the last right answer
        self.assertEqual(q["flags"], {"practised": True, "missed": True})
        self.assertEqual(q["counts"], {"right": 3, "wrong": 2})

    def test_wrong_counter_alone_marks_missed(self):
        # The answer log only keeps 20 answers; the counter remembers older misses.
        history = [{"t": "2026-10-25T10:00:00", "ok": True}]
        q = self.migrate(self.v1_question(1, history, [{"test": "t", "result": "correct"}], {"right": 5, "wrong": 1}))
        self.assertTrue(q["flags"]["missed"])

    def test_box_zero_has_nothing_counted(self):
        q = self.migrate(self.v1_question(0, [{"t": "2026-10-25T10:00:00", "ok": False}],
                                          [{"test": "t", "result": "incorrect"}], {"right": 0, "wrong": 1}))
        self.assertEqual((q["stats"]["streak"], q["stats"]["last_counted"]), (0, None))

    def test_manual_question_never_answered_is_new(self):
        q = self.migrate(self.v1_question(0, [], [{"test": "manual", "result": "manual"}], {"right": 0, "wrong": 0}))
        self.assertEqual(q["flags"], {"practised": False, "missed": False})


class ResetTest(unittest.TestCase):
    def setUp(self):
        self.db = server.empty_db()
        q = bare_question(streak=4, last_counted="2026-10-20T09:00:00", missed=True,
                          sources=[{"test": "test-1", "result": "correct"}])
        q["counts"] = {"right": 9, "wrong": 2}
        q["stats"]["history"] = [{"t": "2026-10-20T09:00:00", "ok": False}]
        self.db["questions"]["q"] = q
        self.db["sessions"] = [{"answers": []}]
        self.db["daily"] = {"2026-10-20": {"answers": 1, "steps": 1, "mastered": 0, "slipped": 0}}

    def test_reset_progress_returns_to_just_after_import(self):
        server.reset_progress(self.db)
        q = self.db["questions"]["q"]
        self.assertEqual(q["stats"]["streak"], 1)  # right in its PDF
        self.assertEqual(q["flags"], {"practised": True, "missed": False})  # the PDF had no miss
        self.assertEqual(q["counts"], {"right": 9, "wrong": 2})  # counters are never reset here
        self.assertEqual((self.db["sessions"], self.db["daily"], q["stats"]["history"]), ([], {}, []))

    def test_start_from_blank_forgets_everything(self):
        server.reset_progress(self.db, blank=True)
        q = self.db["questions"]["q"]
        self.assertEqual((q["stats"]["streak"], q["stats"]["last_counted"]), (0, None))
        self.assertEqual(q["flags"], {"practised": False, "missed": False})
        self.assertEqual(q["counts"], {"right": 0, "wrong": 0})


class ExamPlanTest(unittest.TestCase):
    TODAY = datetime(2026, 10, 25, 9, 0)

    def setUp(self):
        self.clock = FrozenClock(self.TODAY).__enter__()
        self.db = server.empty_db()

    def tearDown(self):
        self.clock.__exit__()

    def study_until_mastered(self, start_streak, exam_in_days, session_every_hours=12):
        """Answer right at every session; return the day it was mastered or None."""
        last = self.TODAY.isoformat() if start_streak else None
        self.db["questions"] = {"q": bare_question(streak=start_streak, last_counted=last)}
        exam = (self.TODAY + timedelta(days=exam_in_days)).date()
        server.set_exam_date(self.db, exam.isoformat())
        s = self.db["questions"]["q"]["stats"]
        while self.clock.when.date() < exam:
            server.record_answer(self.db, "q", True, [])
            if s["streak"] >= M:
                return self.clock.when.date()
            self.clock.advance(hours=session_every_hours)
        return None

    def test_mistake_mastered_before_exam_in_three_days(self):
        mastered = self.study_until_mastered(start_streak=0, exam_in_days=3)
        self.assertEqual(mastered, (self.TODAY + timedelta(days=2)).date())

    def test_question_right_in_pdf_mastered_before_exam(self):
        self.assertIsNotNone(self.study_until_mastered(start_streak=1, exam_in_days=3))

    def test_steps_squeezed_into_hours_when_days_run_out(self):
        self.assertIsNotNone(self.study_until_mastered(start_streak=0, exam_in_days=1, session_every_hours=3))

    def test_no_squeezing_when_the_days_are_enough(self):
        self.db["settings"] = {"exam_date": "2026-11-30"}
        stats = server.new_stats(1, self.TODAY.isoformat())
        self.assertEqual(server.next_count_time(self.db, stats), datetime(2026, 10, 26))

    def test_mastered_question_gets_a_check_before_exam(self):
        self.db["settings"] = {"exam_date": "2026-10-29"}
        stats = server.new_stats(M + 1, self.TODAY.isoformat())  # normally checked 8 days later
        self.assertEqual(server.next_count_time(self.db, stats), datetime(2026, 10, 28))

    def test_past_exam_uses_the_normal_rule(self):
        self.db["settings"] = {"exam_date": "2026-10-20"}
        stats = server.new_stats(M, self.TODAY.isoformat())
        self.assertEqual(server.next_count_time(self.db, stats), datetime(2026, 10, 25 + server.CHECK_DAYS[0]))

    def test_setting_a_date_reschedules_every_question(self):
        self.db["questions"] = {"q": bare_question(streak=M + 2, last_counted=self.TODAY.isoformat())}
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
