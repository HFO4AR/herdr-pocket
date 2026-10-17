"""dirList: the read-only directory tree behind the 新建 sheets' directory picker. Real temporary
folders; the hung-mount cases fake a filesystem call that never returns inside the forked reader."""
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge


def names(listing):
    return [d["name"] for d in listing["dirs"]]


class DirListTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.home = self.base / "home"
        for d in ("projects/app", "Beta", "alpha", ".config/x", "notes"):
            (self.home / d).mkdir(parents=True)
        (self.home / "file.txt").write_text("not a folder")
        self.data = self.base / "mnt/E/work"; self.data.mkdir(parents=True)
        (self.home / "work").symlink_to(self.data)                      # a folder through a link
        (self.home / "readme").symlink_to(self.home / "file.txt")       # a link to a file: not listed
        (self.home / "dead").symlink_to(self.base / "gone")             # a dangling link: not listed
        p = patch.object(bridge.Path, "home", return_value=self.home); p.start(); self.addCleanup(p.stop)

    def ls(self, **kw):
        return bridge.handle(dict(v=1, op="dirList", **kw))

    def test_home_lists_folders_only_sorted_with_links_marked(self):
        r = self.ls(path="~")
        self.assertEqual(r["path"], str(self.home))
        self.assertEqual(r["home"], str(self.home))
        self.assertEqual(r["parent"], str(self.base))
        self.assertEqual(names(r), ["alpha", "Beta", "notes", "projects", "work"])  # case-insensitive order
        self.assertEqual((r["total"], r["truncated"], r["hidden"], r["partial"]), (5, False, 1, False))
        self.assertTrue(r["enter"] and r["list"] and r["write"])
        work = next(d for d in r["dirs"] if d["name"] == "work")
        self.assertEqual((work["link"], work["real"]), (str(self.data), str(self.data)))
        plain = next(d for d in r["dirs"] if d["name"] == "alpha")
        self.assertEqual(plain, {"name": "alpha"})  # only false flags are sent
        # Nothing about files: no file names, sizes or contents anywhere in the answer.
        self.assertNotIn("file.txt", repr(r)); self.assertNotIn("readme", repr(r)); self.assertNotIn("dead", repr(r))

    def test_hidden_folders_and_query(self):
        self.assertEqual(names(self.ls(path="~", hidden=True)), [".config", "alpha", "Beta", "notes", "projects", "work"])
        self.assertEqual(names(self.ls(path="~", query="ET")), ["Beta"])
        self.assertEqual(names(self.ls(path="~/projects/")), ["app"])
        self.assertEqual(self.ls(path="~/projects/./")["path"], str(self.home / "projects"))

    def test_symlinked_directory_is_listed_through_its_link(self):
        (self.data / "proj").mkdir()
        r = self.ls(path="~/work")
        self.assertEqual((r["path"], r["real"], names(r)), (str(self.home / "work"), str(self.data), ["proj"]))

    def test_root(self):
        r = self.ls(path="/")
        self.assertEqual(r["path"], "/")
        self.assertNotIn("parent", r)
        self.assertIn("tmp", names(r))
        self.assertEqual(names(r), sorted(names(r), key=lambda n: (n.casefold(), n)))

    def test_errors_are_answers_not_failures(self):
        (self.home / "locked").mkdir(); (self.home / "locked/inner").mkdir()
        os.chmod(self.home / "locked", 0)
        self.addCleanup(os.chmod, self.home / "locked", 0o700)
        r = self.ls(paths=[str(self.home / "nope"), str(self.home / "file.txt"), str(self.home / "locked"), "relative"])["lists"]
        self.assertEqual([x.get("code") for x in r[:2]], ["missing", "notdir"])
        self.assertEqual(r[0]["error"], "这个目录不存在")
        self.assertEqual(r[3]["code"], "bad")
        if os.geteuid() != 0:
            self.assertEqual((r[2]["code"], r[2]["enter"], r[2]["list"]), ("denied", False, False))
            self.assertNotIn("inner", repr(r[2]))
            # Seen from its parent: flagged, so the phone shows a lock and does not try to open it.
            locked = next(d for d in self.ls(path="~")["dirs"] if d["name"] == "locked")
            self.assertEqual((locked.get("enter"), locked.get("list")), (False, False))

    def test_paths_batch_is_the_way_down(self):
        r = self.ls(paths=["~", "~/projects", "~/projects/app"])["lists"]
        self.assertEqual([x["path"] for x in r], [str(self.home), str(self.home / "projects"), str(self.home / "projects/app")])
        self.assertEqual([names(x) for x in r][1:], [["app"], []])

    def test_huge_directory_is_capped(self):
        big = self.home / "big"; big.mkdir()
        for i in range(30): (big / ("d%02d" % i)).mkdir()
        for i in range(10): (big / ("f%02d" % i)).write_text("")
        with patch.object(bridge, "DIRLIST_MAX", 12):
            r = self.ls(path="~/big")
        self.assertEqual((len(r["dirs"]), r["total"], r["truncated"]), (12, 30, True))
        self.assertEqual(names(r)[:2], ["d00", "d01"])
        # Past the scan limit: the rest of the directory is not looked at, and the answer says so.
        with patch.object(bridge, "DIRLIST_SCAN", 5):
            r = self.ls(path="~/big")
        self.assertTrue(r["truncated"]); self.assertLessEqual(r["total"], 5)

    def test_odd_names_are_skipped(self):
        odd = self.home / "odd"; odd.mkdir()
        os.mkdir(os.fsencode(str(odd)) + b"/bad\xff")   # not UTF-8
        (odd / "two\nlines").mkdir()
        (odd / "fine 中文").mkdir()
        r = self.ls(path="~/odd")
        self.assertEqual((names(r), r["skipped"]), (["fine 中文"], 2))

    def test_hung_directory_times_out(self):
        def hang(*a): time.sleep(30)
        began = time.monotonic()
        with patch.object(bridge, "DIRLIST_TIMEOUT", 0.4), patch.object(bridge, "dir_scan", side_effect=hang):
            r = self.ls(path="~")
        self.assertLess(time.monotonic() - began, 3)
        self.assertEqual((r["code"], r["dirs"]), ("timeout", []))
        self.assertIn("超时", r["error"])

    def test_hung_link_target_keeps_the_rest(self):
        (self.home / "slow").symlink_to(self.base / "mnt/E")
        real_stat = os.stat
        def stat(path, *a, **kw):
            if str(path).endswith("/slow"): time.sleep(30)
            return real_stat(path, *a, **kw)
        with patch.object(bridge, "DIRLIST_TIMEOUT", 0.6), patch.object(bridge.os, "stat", side_effect=stat):
            r = self.ls(path="~")
        self.assertTrue(r["partial"])
        self.assertIn("alpha", names(r))
        slow = next(d for d in r["dirs"] if d["name"] == "slow")
        self.assertEqual((slow["slow"], slow["link"]), (True, str(self.base / "mnt/E")))
        self.assertIn("没响应", r["note"])

    def test_strict_requests(self):
        for kw in (dict(path="relative/x"), dict(path="~root"), dict(path="/a/../b"), dict(path="/a\nb"), dict(path=5),
                   dict(path="/", extra=1), dict(path="/", hidden="yes"), dict(path="/", query="x" * 101),
                   dict(paths=[]), dict(paths=["/"] * 17), dict(paths="/"), dict(paths=["/"], path="/")):
            with self.subTest(kw=kw), self.assertRaises(bridge.BridgeError):
                self.ls(**kw)

    def test_no_session_needed(self):
        # Works the same on a tmux-only computer: no Herdr call at all.
        with patch.object(bridge, "call", side_effect=AssertionError("no Herdr")):
            self.assertIn("projects", names(self.ls(path="~")))


if __name__ == "__main__":
    unittest.main()
