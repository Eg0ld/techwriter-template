#!/usr/bin/env python3
"""The gate between the AI agent and this repository.

The agent reads untrusted code and works in a throwaway copy of the docs. Nothing
it wrote reaches git until this script has accepted it:

  collect         copy changed pages from the agent's copy into the repo
  classification  turn the agent's classification file into safe, bounded data
  changelog       write the changelog page from the run log, as escaped plain text

Standard library only, so it needs no install step.
"""
import argparse
import filecmp
import json
import os
import re
import shutil
import stat
import sys
import unicodedata
from pathlib import Path

MAX_FILE_BYTES = 1_000_000
MAX_FILES = 5_000
MAX_SUMMARY = 240
MAX_PAGES = 200
GAP_TYPES = {"NO_GAP", "MISSING_CONTENT", "OUTDATED_CONTENT", "NEW_PAGE", "STRUCTURAL", "STYLE"}
SEVERITIES = {"low", "medium", "high"}
CATEGORY_KEYS = {"label", "position", "collapsed", "collapsible", "className", "description", "link", "customProps"}
LINK_TYPES = {"doc", "generated-index"}
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


class Refused(Exception):
    pass


def tree(root):
    """Every file under root as {relative path: lstat}, refusing links and special files."""
    found = {}
    for here, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = os.path.join(here, name)
            info = os.lstat(path)
            rel = os.path.relpath(path, root)
            if stat.S_ISLNK(info.st_mode):
                raise Refused(f"{rel}: symbolic links are not accepted")
            if stat.S_ISDIR(info.st_mode):
                if name == ".git":
                    raise Refused(f"{rel}: a nested git directory is not accepted")
                continue
            if not stat.S_ISREG(info.st_mode):
                raise Refused(f"{rel}: not a regular file")
            found[rel] = info
    if len(found) > MAX_FILES:
        raise Refused(f"too many files ({len(found)})")
    return found


def page_allowed(rel):
    parts = Path(rel).parts
    if any(p.startswith(".") for p in parts):
        return False
    return parts[-1].endswith(".md") or parts[-1] == "_category_.json"


def check_markdown(rel, text):
    if "\x00" in text:
        raise Refused(f"{rel}: contains a NUL byte")
    # Front matter can switch a .md page to MDX, which runs as code at build time.
    # YAML also accepts quoted keys and flow style, so look for the key in any form.
    lines = text.lstrip("﻿").split("\n")
    if lines and lines[0].rstrip() == "---":
        for line in lines[1:]:
            if line.rstrip() in ("---", "..."):
                break
            if re.search(r"""(^|[\s{,'"])format['"]?\s*:""", line):
                raise Refused(f"{rel}: the front matter may not set a page format")


def check_category(rel, text):
    try:
        data = json.loads(text)
    except ValueError as err:
        raise Refused(f"{rel}: invalid JSON ({err})")
    if not isinstance(data, dict) or set(data) - CATEGORY_KEYS:
        raise Refused(f"{rel}: unexpected keys")
    link = data.get("link")
    if link is not None and (not isinstance(link, dict) or link.get("type") not in LINK_TYPES):
        raise Refused(f"{rel}: unexpected link")


def check_page(rel, path, size):
    if size > MAX_FILE_BYTES:
        raise Refused(f"{rel}: larger than {MAX_FILE_BYTES} bytes")
    try:
        text = Path(path).read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise Refused(f"{rel}: not UTF-8 text")
    if rel.endswith(".md"):
        check_markdown(rel, text)
    else:
        check_category(rel, text)


def collect(source, dest):
    if not os.path.isdir(source):
        raise Refused(f"the agent's docs folder is missing: {source}")
    os.makedirs(dest, exist_ok=True)
    new = tree(source)
    old = tree(dest)
    changed = [r for r in new if r not in old or not filecmp.cmp(os.path.join(source, r), os.path.join(dest, r), shallow=False)]
    removed = [r for r in old if r not in new]

    # Check everything first: either the whole change is accepted or none of it is.
    for rel in changed:
        if not page_allowed(rel):
            raise Refused(f"{rel}: only .md pages and _category_.json may be changed")
        check_page(rel, os.path.join(source, rel), new[rel].st_size)
    for rel in removed:
        if not page_allowed(rel):
            raise Refused(f"{rel}: only .md pages and _category_.json may be removed")

    for rel in changed:
        target = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(os.path.join(source, rel), target)
    for rel in removed:
        os.unlink(os.path.join(dest, rel))
    print(f"Accepted {len(changed)} changed and {len(removed)} removed page(s).")


def one_line(value, limit):
    text = "".join(c if unicodedata.category(c)[0] != "C" else " " for c in str(value))
    return " ".join(text.split())[:limit]


def md_text(value):
    """Plain text for a Markdown page: one pass, so nothing in it can act as markup."""
    return re.sub(r"([\\`*_{}\[\]<>()#!|~&])", r"\\\1", one_line(value, MAX_SUMMARY))


def classification(source, dest):
    try:
        raw = json.loads(Path(source).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    gap = raw.get("gap_type") if raw.get("gap_type") in GAP_TYPES else "NO_GAP"
    severity = raw.get("severity") if raw.get("severity") in SEVERITIES else "low"
    pages = raw.get("pages") if isinstance(raw.get("pages"), list) else []
    pages = [one_line(p, 200) for p in pages if isinstance(p, str)][:MAX_PAGES]
    out = {"gap_type": gap, "severity": severity, "pages": pages, "summary": one_line(raw.get("summary") or "", MAX_SUMMARY)}
    Path(dest).write_text(json.dumps(out), encoding="utf-8")


def changelog(state_path, dest):
    try:
        state = json.loads(Path(state_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    entries = [e for e in state.get("runLog", []) if isinstance(e, dict) and e.get("gapsFound", 0) > 0]
    if not entries:
        return
    out = [
        "---\nsidebar_label: Changelog\nsidebar_position: 999\n---\n\n",
        "# Changelog\n\n",
        "_Auto-generated — each entry traces a source PR to the doc changes it produced._\n\n",
    ]
    for e in reversed(entries):
        date = re.sub(r"[^0-9-]", "", str(e.get("at", ""))[:10])
        out.append(f"## {date}\n\n{md_text(e.get('summary') or 'Documentation updated.')}\n\n")
        refs = []
        repo, pr, doc_pr = e.get("sourceRepo"), e.get("sourcePr"), e.get("docPr")
        if isinstance(repo, str) and REPO.fullmatch(repo) and isinstance(pr, int):
            refs.append(f"[{repo}#{pr}](https://github.com/{repo}/pull/{pr})")
        if isinstance(doc_pr, int):
            refs.append(f"[Doc PR #{doc_pr}](../../pull/{doc_pr})")
        if refs:
            out.append("**Source:** " + " · ".join(refs) + "\n\n")
        pages = [p for p in e.get("pagesTouched", []) if isinstance(p, str)]
        if pages:
            out.append("**Pages updated:**\n\n" + "".join(f"- {md_text(p)}\n" for p in pages) + "\n")
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    Path(dest).write_text("".join(out), encoding="utf-8")
    print(f"Changelog written to {dest} ({len(entries)} entries)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--from", dest="source", required=True)
    c.add_argument("--to", dest="dest", required=True)
    k = sub.add_parser("classification")
    k.add_argument("--from", dest="source", required=True)
    k.add_argument("--to", dest="dest", required=True)
    h = sub.add_parser("changelog")
    h.add_argument("--state", required=True)
    h.add_argument("--to", dest="dest", required=True)
    args = parser.parse_args()
    try:
        if args.command == "changelog":
            changelog(args.state, args.dest)
        else:
            (collect if args.command == "collect" else classification)(args.source, args.dest)
    except Refused as err:
        print(f"::error::Autoscribe refused the agent's output: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
