#!/usr/bin/env python3
"""Tests for the gate between the agent and the repo. Run: python3 -I .github/scripts/test_autoscribe_guard.py"""
import importlib.util
import json
import os
import re
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("autoscribe-guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class Collect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = Path(self.tmp.name, "agent")
        self.dest = Path(self.tmp.name, "repo")
        self.src.mkdir()
        self.dest.mkdir()
        (self.dest / "intro.md").write_text("# Intro\n")
        (self.src / "intro.md").write_text("# Intro\n")

    def tearDown(self):
        self.tmp.cleanup()

    def refused(self):
        before = sorted(p.name for p in self.dest.rglob("*"))
        with self.assertRaises(guard.Refused):
            guard.collect(str(self.src), str(self.dest))
        self.assertEqual(before, sorted(p.name for p in self.dest.rglob("*")), "a refused change must write nothing")

    def test_accepts_new_and_edited_pages(self):
        (self.src / "intro.md").write_text("# New intro\n")
        (self.src / "guide").mkdir()
        (self.src / "guide" / "a.md").write_text("---\ntitle: A\n---\n\nText\n")
        (self.src / "guide" / "_category_.json").write_text('{"label": "Guide", "position": 2}')
        guard.collect(str(self.src), str(self.dest))
        self.assertEqual((self.dest / "intro.md").read_text(), "# New intro\n")
        self.assertTrue((self.dest / "guide" / "a.md").exists())

    def test_removes_a_retired_page(self):
        (self.src / "intro.md").unlink()
        guard.collect(str(self.src), str(self.dest))
        self.assertFalse((self.dest / "intro.md").exists())

    def test_keeps_an_owners_unchanged_mdx_page(self):
        (self.dest / "owner.mdx").write_text("export const a = 1\n")
        (self.src / "owner.mdx").write_text("export const a = 1\n")
        guard.collect(str(self.src), str(self.dest))
        self.assertTrue((self.dest / "owner.mdx").exists())

    def test_refuses_a_new_mdx_page(self):
        (self.src / "evil.mdx").write_text("export const a = process.cwd()\n")
        self.refused()

    def test_refuses_a_changed_mdx_page(self):
        (self.dest / "owner.mdx").write_text("safe\n")
        (self.src / "owner.mdx").write_text("export const a = 1\n")
        self.refused()

    def test_refuses_removing_a_non_page(self):
        (self.dest / "diagram.png").write_bytes(b"png")
        self.refused()

    def test_refuses_front_matter_that_turns_on_mdx(self):
        for front in ("format: mdx", "'format': mdx", '"format": mdx', "{format: mdx}", "title: a, format: mdx"):
            (self.src / "page.md").write_text(f"---\n{front}\n---\n\nText\n")
            self.refused()

    def test_allows_the_word_format_in_a_page(self):
        (self.src / "page.md").write_text("---\ntitle: Formats\n---\n\nformat: this is body text\n")
        guard.collect(str(self.src), str(self.dest))

    def test_refuses_symlinks(self):
        os.symlink("/etc/passwd", self.src / "link.md")
        self.refused()

    def test_refuses_a_symlinked_folder(self):
        os.symlink("/etc", self.src / "linked")
        self.refused()

    def test_refuses_a_nested_git_folder(self):
        (self.src / ".git").mkdir()
        (self.src / ".git" / "config").write_text("[core]\n\tfsmonitor = /bin/sh\n")
        self.refused()

    def test_refuses_dotfiles_and_other_file_types(self):
        for name in (".gitattributes", "x.js", "x.ts", "x.html", "x.svg"):
            (self.src / name).write_text("x")
            self.refused()
            (self.src / name).unlink()

    def test_refuses_bad_category_files(self):
        for body in ("not json", "[]", '{"label": "a", "evil": 1}', '{"link": {"type": "html"}}'):
            (self.src / "_category_.json").write_text(body)
            self.refused()

    def test_refuses_oversized_and_binary_pages(self):
        (self.src / "big.md").write_text("a" * (guard.MAX_FILE_BYTES + 1))
        self.refused()
        (self.src / "big.md").unlink()
        (self.src / "bin.md").write_bytes(b"\xff\xfe\x00")
        self.refused()


class Classification(unittest.TestCase):
    def run_on(self, payload):
        with tempfile.TemporaryDirectory() as d:
            src, dest = Path(d, "in.json"), Path(d, "out.json")
            src.write_text(payload if isinstance(payload, str) else json.dumps(payload))
            guard.classification(str(src), str(dest))
            return json.loads(dest.read_text())

    def test_defaults_when_missing_or_bad(self):
        self.assertEqual(self.run_on("not json")["gap_type"], "NO_GAP")
        self.assertEqual(self.run_on({"gap_type": "EVIL"})["gap_type"], "NO_GAP")
        self.assertEqual(self.run_on([1])["gap_type"], "NO_GAP")

    def test_summary_is_one_line_of_text(self):
        out = self.run_on({"gap_type": "STYLE", "summary": "x\ny\x00z"})
        self.assertEqual(out["summary"], "x y z")

    def test_changelog_cannot_carry_html_or_links(self):
        hostile = "\\\\<img src=y onerror=z> [a](javascript:b)"
        state = {"runLog": [{"gapsFound": 1, "at": "2026-11-23T00:00:00Z", "summary": hostile, "sourceRepo": "a/b", "sourcePr": 1,
                             "docPr": 2, "pagesTouched": ["docs/<script>.md"]},
                            {"gapsFound": 1, "at": "x", "summary": "s", "sourceRepo": "a/b)(javascript:c", "sourcePr": 3}]}
        with tempfile.TemporaryDirectory() as d:
            src, dest = Path(d, "state.json"), Path(d, "changelog.md")
            src.write_text(json.dumps(state))
            guard.changelog(str(src), str(dest))
            text = dest.read_text()
        # After removing escaped pairs, no markup character from the input is left.
        bare = re.sub(r"\\.", "", text)
        self.assertNotIn("<", bare)
        self.assertNotIn("](javascript", bare)
        self.assertNotIn("javascript:c", text)

    def test_summary_is_bounded(self):
        self.assertLessEqual(len(self.run_on({"summary": "a" * 5000})["summary"]), guard.MAX_SUMMARY)


if __name__ == "__main__":
    unittest.main()
