import re
import shutil
import unittest
from pathlib import Path

from pdf_parser import ParseError, parse_pdf, parse_xml
from tests.helpers import FIXTURES

SAMPLE = (FIXTURES / "sample_results.xml").read_text(encoding="utf-8")
PDF_DIR = Path(__file__).resolve().parent.parent / "pdfs"


class SampleResultsTest(unittest.TestCase):
    """The synthetic results page in tests/fixtures covers each layout case the parser handles."""

    def setUp(self):
        self.result = parse_xml(SAMPLE, "test-99-1e.pdf")
        self.qs = self.result["questions"]

    def test_finds_every_question(self):
        self.assertEqual(len(self.qs), 3)
        self.assertEqual(self.result["warnings"], [])

    def test_reads_score_from_header(self):
        self.assertEqual((self.result["score"], self.result["total"]), (2, 3))

    def test_joins_question_wrapped_over_two_lines(self):
        self.assertEqual(self.qs[0]["text"], "Which river flows through the imaginary town of Testbury on its way to the sea?")

    def test_bold_options_are_the_correct_answers(self):
        self.assertEqual(self.qs[0]["options"], ["The Alpha", "The Beta", "The Gamma", "The Delta"])
        self.assertEqual(self.qs[0]["correct"], [1])

    def test_multi_answer_question_with_wrapped_option(self):
        q = self.qs[1]
        self.assertEqual(q["options"], [
            "Glimmer", "Red", "Shadowmint, the colour of a test suite that passes on the first attempt", "Blue",
        ])
        self.assertEqual(q["correct"], [0, 2])

    def test_true_false_question_after_page_break(self):
        q = self.qs[2]
        self.assertEqual(q["text"], "Unit tests can catch regressions before they reach users.")
        self.assertEqual((q["options"], q["correct"]), (["True", "False"], [0]))

    def test_result_of_each_question(self):
        self.assertEqual([q["result"] for q in self.qs], ["correct", "incorrect", "correct"])

    def test_explanation_merges_inline_bold_and_fixes_punctuation_spacing(self):
        self.assertEqual(self.qs[0]["explanation"], "The river through Testbury is the Beta.")
        self.assertEqual(self.qs[1]["explanation"],
                         "Glimmer and Shadowmint are invented colours; red and blue are real ones.")

    def test_footer_does_not_leak_into_last_explanation(self):
        self.assertEqual(self.qs[2]["explanation"], "This statement is TRUE.")

    def test_site_links_are_not_treated_as_content(self):
        for q in self.qs:
            self.assertNotIn("https://", " ".join([q["text"], *q["options"], q["explanation"]]))


class FileNameTest(unittest.TestCase):
    def test_test_and_exam_names(self):
        self.assertEqual(parse_xml(SAMPLE, "test-11-1e.pdf")["test_id"], "test-11")
        exam = parse_xml(SAMPLE, "exam-17-1e.pdf")
        self.assertEqual((exam["test_id"], exam["title"]), ("exam-17", "Exam 17"))

    def test_leading_zeros_name_the_same_test(self):
        a, b = parse_xml(SAMPLE, "test-01-1e.pdf"), parse_xml(SAMPLE, "test-1-1e.pdf")
        self.assertEqual((a["test_id"], a["title"]), ("test-1", "Test 1"))
        self.assertEqual(a["test_id"], b["test_id"])

    def test_unrecognised_name_falls_back_to_file_stem(self):
        r = parse_xml(SAMPLE, "My Results.pdf")
        self.assertEqual((r["test_id"], r["title"], r["file"]), ("my results", "My Results", "My Results.pdf"))

    def test_warns_when_filename_error_count_disagrees(self):
        warnings = parse_xml(SAMPLE, "test-99-4e.pdf")["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("filename says 4", warnings[0])


class BadInputTest(unittest.TestCase):
    def test_page_without_questions_is_an_error(self):
        xml = '<page number="1"><text top="10" left="39" width="9" height="16" font="1">Hello</text></page>'
        with self.assertRaises(ParseError):
            parse_xml(xml, "test-1-0e.pdf")

    def test_warns_when_question_count_differs_from_header(self):
        # Drop the third question: the header still says 3.
        xml = SAMPLE.split('<page number="2"')[0] + "</pdf2xml>"
        warnings = parse_xml(xml, "test-99-1e.pdf")["warnings"]
        self.assertTrue(any("found 2 questions but the PDF says 3" in w for w in warnings), warnings)


@unittest.skipUnless(shutil.which("pdftohtml"), "pdftohtml (poppler) is not installed")
@unittest.skipUnless(PDF_DIR.is_dir() and any(PDF_DIR.glob("*.pdf")), "no PDFs in pdfs/ (they are not in the repo)")
class RealPdfsTest(unittest.TestCase):
    """Runs only on a machine with your own PDFs in pdfs/: every one must import cleanly."""

    def test_every_pdf_parses_without_warnings(self):
        for pdf in sorted(PDF_DIR.glob("*.pdf")):
            with self.subTest(pdf=pdf.name):
                r = parse_pdf(pdf)
                self.assertEqual(r["warnings"], [])
                self.assertEqual(len(r["questions"]), r["total"])
                m = re.search(r"-(\d+)e$", pdf.stem)
                if m:
                    wrong = sum(q["result"] == "incorrect" for q in r["questions"])
                    self.assertEqual(wrong, int(m[1]), "error count in the filename")


if __name__ == "__main__":
    unittest.main()
