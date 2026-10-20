"""CC Switch integration: read-only provider listing and guarded Claude/Codex switching.

Every test uses a temporary HOME with a fake cc-switch.db and fake ~/.claude / ~/.codex files.
The real ~/.cc-switch, ~/.claude and ~/.codex are never opened. The only secret-shaped strings
below are fixtures; assertions make sure none of them appears in a bridge response.
"""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

CLAUDE_OLD_TOKEN = "sk-claude-old-secret-123"
CLAUDE_NEW_TOKEN = "sk-claude-new-secret-456"
CODEX_OLD_TOKEN = "sk-codex-old-secret-789"
CODEX_NEW_TOKEN = "sk-codex-new-secret-abc"
OLD_URL = "https://deepseek.invalid/anthropic"
NEW_URL = "https://other.invalid/v1"
KIMI_URL = "https://kimi.invalid/v1"
SECRETS = (CLAUDE_OLD_TOKEN, CLAUDE_NEW_TOKEN, CODEX_OLD_TOKEN, CODEX_NEW_TOKEN, OLD_URL, NEW_URL, KIMI_URL)

CLAUDE_CURRENT = {
    "env": {
        "ANTHROPIC_AUTH_TOKEN": CLAUDE_OLD_TOKEN,
        "ANTHROPIC_BASE_URL": OLD_URL,
        "ANTHROPIC_MODEL": "deepseek-chat",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-haiku",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "DeepSeek Haiku",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-sonnet",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-opus",
    }
}
CLAUDE_OTHER = {
    "env": {
        "ANTHROPIC_AUTH_TOKEN": CLAUDE_NEW_TOKEN,
        "ANTHROPIC_BASE_URL": NEW_URL,
        "ANTHROPIC_MODEL": "other-model",
        "ANTHROPIC_DEFAULT_FABLE_MODEL": "other-fable",
        "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "Other Fable",
    }
}
CLAUDE_EMPTY = {"env": {}}
COMMON_CLAUDE = {
    "env": {"API_TIMEOUT_MS": "600000", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"},
    "includeCoAuthoredBy": True,
    "model": "haiku",
    "hooks": {"SessionStart": [{"matcher": "", "hooks": [{"type": "command", "command": "common-hook"}]}]},
    "statusLine": {"type": "command", "command": "common-status"},
    "tui": "fullscreen",
    "theme": "dark",
}
CURRENT_CLAUDE = {
    "env": {"ANTHROPIC_AUTH_TOKEN": CLAUDE_OLD_TOKEN, "ANTHROPIC_BASE_URL": OLD_URL},
    "statusLine": {"type": "command", "command": "my-status"},
    "hooks": {"SessionStart": [{"matcher": "", "hooks": [{"type": "command", "command": "user-hook"}]}],
              "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "prompt-hook"}]}]},
    "modelSettings": {"mine": {"effortLevel": "low"}},
    "theme": "light",
}
COMMON_CODEX = '[projects."/tmp/shared"]\ntrust_level = "trusted"\n'
CURRENT_CODEX = """model = "old-model"
model_provider = "oldcustom"

[projects."/home/u/mine"]
trust_level = "trusted"

[tui]
status_line = ["x", "y"]

[model_providers.oldcustom]
name = "old"
base_url = "https://old.invalid/v1"
"""
KIMI_CODEX = """model_provider = "custom"
model = "kimi-for-coding"
model_reasoning_effort = "high"

[model_providers]
[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://kimi.invalid/v1"

[projects]
[projects."/tmp/kimi"]
trust_level = "trusted"
"""
ENVKEY_CODEX = """model = "envkey-model"
model_provider = "envkey"

[model_providers.envkey]
name = "envkey"
env_key = "ENVKEY_API_KEY"
base_url = "https://envkey.invalid/v1"
"""
DEFAULT_CODEX = """model = "gpt-5.5"
model_reasoning_effort = "medium"

[projects."/home/u/mine"]
trust_level = "trusted"
"""
CURRENT_AUTH = {"auth_mode": "chatgpt", "OPENAI_API_KEY": CODEX_OLD_TOKEN, "tokens": {"access_token": CODEX_OLD_TOKEN}}
KIMI_AUTH = {"OPENAI_API_KEY": CODEX_NEW_TOKEN}


class CCSwitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / ".cc-switch").mkdir()
        (self.home / ".claude").mkdir()
        (self.home / ".codex").mkdir()
        self.db = self.home / ".cc-switch" / "cc-switch.db"
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, "
                     "settings_config TEXT NOT NULL, category TEXT, sort_index INTEGER, "
                     "is_current BOOLEAN NOT NULL DEFAULT 0, PRIMARY KEY (id, app_type))")
        conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
        rows = [
            ("deepseek", "claude", "DeepSeek", json.dumps(CLAUDE_CURRENT), "cn_official", 1, 1),
            ("other", "claude", "Other Provider", json.dumps(CLAUDE_OTHER), None, 2, 0),
            ("claude-official", "claude", "Claude Official", json.dumps({"env": {}, "model": "opus"}), "official", 3, 0),
            ("empty", "claude", "No Config", json.dumps(CLAUDE_EMPTY), None, 4, 0),
            ("default", "codex", "default", json.dumps({"auth": CURRENT_AUTH, "config": DEFAULT_CODEX}), "custom", 1, 1),
            ("kimi", "codex", "kimi", json.dumps({"auth": KIMI_AUTH, "config": KIMI_CODEX}), None, 2, 0),
            ("envkey", "codex", "envkey", json.dumps({"auth": {}, "config": ENVKEY_CODEX}), None, 3, 0),
            ("codex-official", "codex", "OpenAI Official", json.dumps({}), "official", 4, 0),
            ("gemini-official", "gemini", "Google Official", json.dumps({}), "official", 5, 0),
        ]
        conn.executemany("INSERT INTO providers VALUES (?,?,?,?,?,?,?)", rows)
        conn.executemany("INSERT INTO settings VALUES (?,?)", [
            ("common_config_claude", json.dumps(COMMON_CLAUDE)),
            ("common_config_codex", COMMON_CODEX),
        ])
        conn.commit(); conn.close()

        self.write_json(self.home / ".cc-switch" / "settings.json", {
            "showInTray": True, "currentProviderClaude": "deepseek", "currentProviderCodex": "default"})
        self.write_json(self.home / ".claude" / "settings.json", CURRENT_CLAUDE)
        self.write_text(self.home / ".codex" / "config.toml", CURRENT_CODEX)
        self.write_json(self.home / ".codex" / "auth.json", CURRENT_AUTH)
        os.chmod(self.home / ".claude" / "settings.json", 0o644)
        os.chmod(self.home / ".codex" / "auth.json", 0o600)

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @staticmethod
    def write_text(path, value):
        path.write_text(value, encoding="utf-8")

    def read_json(self, path):
        return json.loads(Path(path).read_text(encoding="utf-8"))

    def db_rows(self, query):
        conn = sqlite3.connect(self.db)
        try: return conn.execute(query).fetchall()
        finally: conn.close()

    def provider(self, result, provider):
        return next(item for item in result["providers"] if item["id"] == provider)

    def assert_no_secrets(self, value):
        rendered = json.dumps(value, ensure_ascii=False)
        for secret in SECRETS:
            self.assertNotIn(secret, rendered)

    def test_list_reports_names_models_and_current_without_secrets(self):
        result = bridge.ccswitch_providers(home=self.home)
        self.assertTrue(result["available"])
        self.assertEqual(result["current"], {"claude": "deepseek", "codex": "default"})
        self.assert_no_secrets(result)
        self.assertNotIn("settings_config", json.dumps(result))
        claude = self.provider(result, "deepseek")
        self.assertTrue(claude["is_current"])
        self.assertFalse(claude["official"])
        self.assertTrue(claude["switchable"])
        self.assertIn({"slot": "默认", "model": "deepseek-chat"}, claude["models"])
        self.assertIn({"slot": "Haiku", "model": "deepseek-haiku", "name": "DeepSeek Haiku"}, claude["models"])
        official = self.provider(result, "claude-official")
        self.assertFalse(official["switchable"])
        self.assertIn("官方", official["reason"])
        empty = self.provider(result, "empty")
        self.assertFalse(empty["switchable"])
        self.assertIn("配置", empty["reason"])
        codex = self.provider(result, "kimi")
        self.assertEqual(codex["models"], [{"slot": "默认", "model": "kimi-for-coding"}])
        self.assertEqual(codex["model_provider"], "custom")
        self.assertNotIn("gemini-official", [p["id"] for p in result["providers"]])

    def test_missing_ccswitch_is_friendly_and_never_writes(self):
        with tempfile.TemporaryDirectory() as empty:
            home = Path(empty)
            result = bridge.ccswitch_providers(home=home)
            self.assertFalse(result["available"])
            self.assertIn("电脑上没有 CC Switch", result["reason"])
            with self.assertRaisesRegex(bridge.BridgeError, "电脑上没有 CC Switch"):
                bridge.ccswitch_switch({"app": "claude", "provider": "deepseek"}, home=home)
            self.assertEqual(list(home.iterdir()), [])

    def test_corrupt_database_is_reported(self):
        self.db.write_bytes(b"this is not a sqlite database")
        result = bridge.ccswitch_providers(home=self.home)
        self.assertFalse(result["available"])
        self.assertIn("数据库读不出来", result["reason"])
        with self.assertRaisesRegex(bridge.BridgeError, "数据库读不出来"):
            bridge.ccswitch_switch({"app": "claude", "provider": "deepseek"}, home=self.home)
        self.assertEqual(self.read_json(self.home / ".claude" / "settings.json"), CURRENT_CLAUDE)

    def test_switch_rejects_invalid_apps_ids_official_and_empty_providers(self):
        before = self.read_json(self.home / ".claude" / "settings.json")
        cases = [
            ({"app": "gemini", "provider": "deepseek"}, "只支持"),
            ({"app": "claude", "provider": "../../etc/passwd"}, "供应商无效"),
            ({"app": "claude", "provider": "nope"}, "找不到"),
            ({"app": "claude", "provider": "claude-official"}, "官方"),
            ({"app": "codex", "provider": "default"}, "官方"),
            ({"app": "claude", "provider": "empty"}, "配置"),
        ]
        for request, message in cases:
            with self.subTest(request=request):
                with self.assertRaisesRegex(bridge.BridgeError, message):
                    bridge.ccswitch_switch(request, home=self.home)
        self.assertEqual(self.read_json(self.home / ".claude" / "settings.json"), before)
        self.assertFalse(list((self.home / ".claude").glob("*.ccswitch-backup-*")))

    def test_claude_switch_merges_backs_up_and_switches_only_new_sessions(self):
        before = (self.home / ".claude" / "settings.json").read_bytes()
        result = bridge.ccswitch_switch({"app": "claude", "provider": "other"}, home=self.home)
        self.assertTrue(result["switched"])
        self.assertTrue(result["new_sessions_only"])
        self.assertIn("新打开的 Claude 会话", result["message"])
        self.assert_no_secrets(result)

        merged = self.read_json(self.home / ".claude" / "settings.json")
        # Provider env replaces the old provider's env completely (no stale token/base URL/model slots).
        self.assertEqual(merged["env"]["ANTHROPIC_AUTH_TOKEN"], CLAUDE_NEW_TOKEN)
        self.assertEqual(merged["env"]["ANTHROPIC_BASE_URL"], NEW_URL)
        self.assertEqual(merged["env"]["ANTHROPIC_MODEL"], "other-model")
        self.assertNotIn("ANTHROPIC_DEFAULT_HAIKU_MODEL", merged["env"], "old provider slot must not survive")
        self.assertNotIn(CLAUDE_OLD_TOKEN, json.dumps(merged))
        # Common config is merged; current statusLine and user fields stay.
        self.assertEqual(merged["env"]["API_TIMEOUT_MS"], "600000")
        self.assertEqual(merged["model"], "haiku")
        self.assertEqual(merged["statusLine"]["command"], "my-status")
        self.assertEqual(merged["modelSettings"], {"mine": {"effortLevel": "low"}})
        commands = [hook["command"] for row in merged["hooks"]["SessionStart"] for hook in row["hooks"]]
        self.assertIn("user-hook", commands)
        self.assertIn("common-hook", commands)
        self.assertEqual(len(commands), len(set(commands)), "hooks are not duplicated")
        self.assertIn("UserPromptSubmit", merged["hooks"])
        self.assertEqual(stat.S_IMODE(os.stat(self.home / ".claude" / "settings.json").st_mode), 0o600)

        backups = list((self.home / ".claude").glob("settings.json.ccswitch-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        self.assertEqual(stat.S_IMODE(os.stat(backups[0]).st_mode), 0o600)

        cc_settings = self.read_json(self.home / ".cc-switch" / "settings.json")
        self.assertEqual(cc_settings["currentProviderClaude"], "other")
        self.assertTrue(cc_settings["showInTray"], "other CC Switch settings are preserved")
        self.assertEqual(stat.S_IMODE(os.stat(self.home / ".cc-switch" / "settings.json").st_mode), 0o600)
        rows = self.db_rows("SELECT id, is_current FROM providers WHERE app_type='claude' ORDER BY id")
        self.assertEqual(dict(rows), {"claude-official": 0, "deepseek": 0, "empty": 0, "other": 1})
        listed = bridge.ccswitch_providers(home=self.home)
        self.assertEqual(listed["current"]["claude"], "other")
        self.assertTrue(self.provider(listed, "other")["is_current"])

    def test_codex_switch_merges_user_config_writes_auth_and_backs_up_both(self):
        before_config = (self.home / ".codex" / "config.toml").read_bytes()
        before_auth = (self.home / ".codex" / "auth.json").read_bytes()
        result = bridge.ccswitch_switch({"app": "codex", "provider": "kimi"}, home=self.home)
        self.assertTrue(result["switched"])
        self.assert_no_secrets(result)
        merged = bridge._toml_parse((self.home / ".codex" / "config.toml").read_text(encoding="utf-8"))
        self.assertEqual(merged["model"], "kimi-for-coding")
        self.assertEqual(merged["model_provider"], "custom")
        self.assertEqual(merged["model_reasoning_effort"], "high")
        self.assertEqual(merged["model_providers"]["custom"]["base_url"], KIMI_URL)
        self.assertNotIn("oldcustom", merged.get("model_providers", {}), "stale provider table removed")
        self.assertEqual(merged["projects"]["/home/u/mine"]["trust_level"], "trusted")
        self.assertEqual(merged["projects"]["/tmp/shared"]["trust_level"], "trusted")
        self.assertEqual(merged["projects"]["/tmp/kimi"]["trust_level"], "trusted")
        self.assertEqual(merged["tui"]["status_line"], ["x", "y"])
        self.assertEqual(stat.S_IMODE(os.stat(self.home / ".codex" / "config.toml").st_mode), 0o600)
        self.assertEqual(self.read_json(self.home / ".codex" / "auth.json"), KIMI_AUTH)
        self.assertEqual(stat.S_IMODE(os.stat(self.home / ".codex" / "auth.json").st_mode), 0o600)

        config_backups = list((self.home / ".codex").glob("config.toml.ccswitch-backup-*"))
        auth_backups = list((self.home / ".codex").glob("auth.json.ccswitch-backup-*"))
        self.assertEqual(len(config_backups), 1)
        self.assertEqual(len(auth_backups), 1)
        self.assertEqual(config_backups[0].read_bytes(), before_config)
        self.assertEqual(auth_backups[0].read_bytes(), before_auth)
        for backup in config_backups + auth_backups:
            self.assertEqual(stat.S_IMODE(os.stat(backup).st_mode), 0o600)

        self.assertEqual(self.read_json(self.home / ".cc-switch" / "settings.json")["currentProviderCodex"], "kimi")
        rows = self.db_rows("SELECT id, is_current FROM providers WHERE app_type='codex' ORDER BY id")
        self.assertEqual(dict(rows), {"codex-official": 0, "default": 0, "envkey": 0, "kimi": 1})

    def test_provider_without_own_auth_keeps_current_auth_file(self):
        before_auth = (self.home / ".codex" / "auth.json").read_bytes()
        bridge.ccswitch_switch({"app": "codex", "provider": "envkey"}, home=self.home)
        self.assertEqual((self.home / ".codex" / "auth.json").read_bytes(), before_auth)
        merged = bridge._toml_parse((self.home / ".codex" / "config.toml").read_text(encoding="utf-8"))
        self.assertEqual(merged["model_provider"], "envkey")
        self.assertEqual(merged["model_providers"]["envkey"]["env_key"], "ENVKEY_API_KEY")

    def test_bad_common_config_aborts_before_writing(self):
        conn = sqlite3.connect(self.db)
        conn.execute("UPDATE settings SET value='not json' WHERE key='common_config_claude'")
        conn.commit(); conn.close()
        before = (self.home / ".claude" / "settings.json").read_bytes()
        with self.assertRaisesRegex(bridge.BridgeError, "公共配置"):
            bridge.ccswitch_switch({"app": "claude", "provider": "other"}, home=self.home)
        self.assertEqual((self.home / ".claude" / "settings.json").read_bytes(), before)
        self.assertFalse(list((self.home / ".claude").glob("*.ccswitch-backup-*")))
        self.assertEqual(self.read_json(self.home / ".cc-switch" / "settings.json")["currentProviderClaude"], "deepseek")

    def test_handle_dispatches_list_and_switch_ops(self):
        with patch.object(bridge.Path, "home", return_value=str(self.home)):
            listed = bridge.handle({"v": 1, "op": "ccswitch"})
            self.assertTrue(listed["available"])
            self.assertTrue(bridge.handle({"v": 1, "op": "providers"})["available"])
            switched = bridge.handle({"v": 1, "op": "ccswitchSwitch", "app": "claude", "provider": "other"})
            self.assertTrue(switched["switched"])

    def test_limited_toml_reader_matches_stdlib_and_round_trips(self):
        sample = """# comment
title = "TOML Example"
enabled = true
count = 1_000
ratio = 1.5

[owner]
name = 'Tom "A"'
tags = [
  "a", # inline comment
  "b",
]

[servers.alpha]
ip = "10.0.0.1"
ports = [8000, 8001]

[[items]]
name = "first"

[[items]]
name = "second"
"""
        limited = bridge._TomlParser(sample).parse()
        stdlib = bridge._toml_parse(sample)
        self.assertEqual(limited, stdlib)
        round_trip = bridge._toml_parse(bridge._toml_dumps(limited))
        self.assertEqual(round_trip, stdlib)
        # Dates are kept verbatim rather than reinterpreted, and stdlib date objects serialize back.
        self.assertEqual(bridge._TomlParser("x = 1979-05-27T07:32:00Z").parse()["x"], "1979-05-27T07:32:00Z")
        dated = bridge._toml_parse("x = 1979-05-27T07:32:00Z")
        self.assertEqual(bridge._toml_parse(bridge._toml_dumps(dated)), dated)

    def test_no_real_home_paths_are_used(self):
        # Guard against a test accidentally writing into the developer's real CC Switch/Claude/Codex.
        self.assertTrue(str(self.home).startswith(tempfile.gettempdir()))
        self.assertTrue(self.db.is_file())
        self.assertNotEqual(self.home, Path.home())


if __name__ == "__main__":
    unittest.main()
