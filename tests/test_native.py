"""Plain Claude/Codex processes outside Herdr: only active main conversations are listed, and only
their catalog metadata leaves the bridge (no environment, no transcript content)."""
import unittest
from unittest.mock import patch
from test_bridge import bridge


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.records = [
            {"provider": "claude", "thread": "T1", "parent": None, "cwd": "/p", "title": "current", "modified": 10.0, "id": "r1"},
            {"provider": "claude", "thread": "T2", "parent": None, "cwd": "/p", "title": "old", "modified": 5.0, "id": "r2"},
            {"provider": "claude", "thread": "sub", "parent": "T1", "cwd": "/p", "title": "sub", "modified": 9.0, "id": "r3"},
            {"provider": "codex", "thread": "C1", "parent": None, "cwd": "/q", "title": "codex", "modified": 7.0, "id": "r4"},
        ]
        self.processes = [(101, ["claude"]), (202, ["codex", "resume", "C1"]), (303, ["codex", "app-server"])]
        self.snaps = {
            101: {"active_threads": ["T1"], "paths": [], "cwd": "/p"},
            202: {"active_threads": [], "paths": [], "cwd": "/q"},
            303: {"active_threads": [], "paths": [], "cwd": "/q"},
        }

    def patches(self):
        return [
            patch.object(bridge, "transcript_catalog", return_value=self.records),
            patch.object(bridge, "user_processes", return_value=list(self.processes)),
            patch.object(bridge, "process_snapshot", side_effect=lambda pid: self.snaps.get(pid)),
            patch.object(bridge, "is_agent_process", side_effect=lambda argv, kind:
                         (kind == "claude" and argv[0] == "claude") or (kind == "codex" and argv[0] == "codex")),
            patch.object(bridge, "explicit_session_ids", side_effect=lambda argv, kind:
                         {"C1"} if kind == "codex" and argv[:2] == ["codex", "resume"] else set()),
        ]

    def test_only_active_main_conversations(self):
        patchers = self.patches()
        for p in patchers:
            p.start()
        try:
            out = bridge.native_sessions()
        finally:
            for p in patchers:
                p.stop()
        self.assertEqual([(x["provider"], x["thread"]) for x in out["sessions"]], [("claude", "T1"), ("codex", "C1")])
        self.assertEqual(out["sessions"][0]["record"]["title"], "current")
        self.assertNotIn("_path", out["sessions"][0]["record"])

    def test_active_threads_include_explicit_resume(self):
        patches = self.patches()
        for p in patches:
            p.start()
        try:
            self.assertEqual(bridge.active_agent_threads(), {"T1", "C1"})
        finally:
            for p in patches:
                p.stop()


if __name__ == "__main__":
    unittest.main()
