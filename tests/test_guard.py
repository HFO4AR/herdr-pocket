"""Herdr server health, 「启动 Herdr」 and the opt-in 「Herdr 守护」.

Everything runs against a fake HOME / XDG_CONFIG_HOME and fake `herdr`, `systemctl`, `systemd-run`,
`loginctl`, `crontab`, `journalctl` on PATH: nothing is installed into the real systemd or crontab,
and no real Herdr server is started, stopped or signalled. Each fake appends its argv to calls.log.
"""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

BRIDGE = Path(__file__).parents[1] / "bridge/pocket_bridge.py"
spec = importlib.util.spec_from_file_location("bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
G = bridge.guard_module()

UUID = "12345678-1234-4234-8234-123456789abc"
UUID2 = "12345678-1234-4234-8234-123456789abd"

# A fake Herdr: `status server --json` / `status --json` from fake/herdr.json; `server` refuses when
# "running", else logs a startup line with its pid to the server log and marks itself running.
FAKE_HERDR = r'''#!/usr/bin/env python3
import json, os, sys, time
home = os.environ["HOME"]
with open(os.path.join(home, "calls.log"), "a") as f: f.write(json.dumps(["herdr"] + sys.argv[1:]) + "\n")
conf = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "herdr")
state_path = os.path.join(home, "fake", "herdr.json")
try: st = json.load(open(state_path))
except OSError: st = {"running": False}
def server():
    return {"status": "running" if st["running"] else "not_running", "running": st["running"], "version": st.get("version", "0.8.2") if st["running"] else None,
            "protocol": 20 if st["running"] else None, "compatible": st.get("compatible", True) if st["running"] else None,
            "socket": os.path.join(conf, "herdr.sock"), "session": None, "restart_needed": False}
args = sys.argv[1:]
if args[:3] == ["status", "server", "--json"]: print(json.dumps(server())); sys.exit(0)
if args[:2] == ["status", "--json"]: print(json.dumps({"client": {"version": "0.8.2", "protocol": 20}, "server": server()})); sys.exit(0)
if args[:3] == ["session", "list", "--json"]:
    print(json.dumps({"sessions": [{"name": "default", "default": True, "running": st["running"]}]})); sys.exit(0)
if args == ["server"]:
    if st["running"]: print("error: herdr server is already running", file=sys.stderr); sys.exit(1)
    os.makedirs(conf, exist_ok=True)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S.000000Z", time.gmtime())
    with open(os.path.join(conf, "herdr-server.log"), "a") as f:
        f.write('%s  INFO herdr::logging: herdr starting event="app.startup" subsystem="server" outcome="started" pid=%d\n' % (stamp, os.getpid()))
    st["running"] = True; st["pid"] = os.getpid()
    os.makedirs(os.path.dirname(state_path), exist_ok=True); json.dump(st, open(state_path, "w"))
    sys.exit(0)
print("unexpected " + " ".join(args), file=sys.stderr); sys.exit(2)
'''

# systemctl / systemd-run / loginctl / crontab / journalctl / busctl: driven by files in fake/.
FAKE_TOOL = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
home = os.environ["HOME"]; name = os.path.basename(sys.argv[0]); args = sys.argv[1:]
with open(os.path.join(home, "calls.log"), "a") as f: f.write(json.dumps([name] + args) + "\n")
fake = os.path.join(home, "fake")
def get(key, default=""):
    try: return open(os.path.join(fake, key)).read()
    except OSError: return default
def put(key, value):
    os.makedirs(fake, exist_ok=True); open(os.path.join(fake, key), "w").write(value)
if name == "systemctl":
    if get("systemd", "running") == "offline" and "--user" in args: print("Failed to connect to bus", file=sys.stderr); sys.exit(1)
    if args[:2] == ["--user", "is-system-running"]: print(get("systemd", "running")); sys.exit(0)
    if args[:1] == ["show"] and args[1].startswith("user@"): print(get("floor", "100")); sys.exit(0)
    if args[:2] == ["--user", "show"]: print(get("default", "200")); sys.exit(0)
    if args[:2] == ["--user", "is-active"]: print(get("active", "inactive")); sys.exit(0 if get("active") == "active" else 3)
    if args[:2] == ["--user", "is-enabled"]: print(get("enabled", "disabled")); sys.exit(0)
    if args[:2] == ["--user", "daemon-reload"]: sys.exit(int(get("fail_reload", "0")))
    if args[:2] == ["--user", "enable"]: put("enabled", "enabled"); sys.exit(int(get("fail_enable", "0")))
    if args[:2] == ["--user", "restart"]: put("active", "active"); sys.exit(0)
    if args[:3] == ["--user", "disable", "--now"]: put("enabled", "disabled"); put("active", "inactive"); sys.exit(0)
    if args[:2] == ["--user", "reset-failed"]: sys.exit(0)
    print("unexpected systemctl " + " ".join(args), file=sys.stderr); sys.exit(2)
if name == "systemd-run":
    # Runs the command after "--" right away (the fake herdr server exits after marking itself up).
    cmd = args[args.index("--") + 1:]
    sys.exit(subprocess.call(cmd))
if name == "loginctl": print(get("linger", "no")); sys.exit(0)
if name == "busctl": print("b " + get("kup", "false")); sys.exit(0)
if name == "crontab":
    if args == ["-l"]:
        text = get("crontab", None)
        if text is None: print("no crontab for tester", file=sys.stderr); sys.exit(1)
        sys.stdout.write(text); sys.exit(0)
    if args == ["-"]: put("crontab", sys.stdin.read()); sys.exit(0)
if name == "journalctl":
    import re
    pattern = args[args.index("-g") + 1]
    lines = [l for l in get("journal").splitlines() if re.search(pattern, l)]
    print("\n".join(lines)); sys.exit(0 if lines else 1)
sys.exit(2)
'''


def startup(t, pid):
    return '%s  INFO herdr::logging: herdr starting event="app.startup" subsystem="server" outcome="started" pid=%d\n' % (t, pid)


def shutdown(t, pid):
    return ('%s  INFO herdr::server::headless: server shutdown initiated\n' % t +
            '%s  INFO herdr::logging: herdr exiting event="app.shutdown" subsystem="server" outcome="completed" pid=%d\n' % (t, pid))


def iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%S.123456Z", time.gmtime(epoch))


class Fake:
    """A fake home with fake tools on PATH; HOME, XDG_CONFIG_HOME and PATH point at it."""
    def __init__(self, systemd="running", linger="no", crontab=True, systemd_tools=True, system_path=True):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.bin = Path(self.tmp.name) / "bin"
        (self.home / ".config").mkdir(parents=True)
        self.bin.mkdir()
        self.tool("herdr", FAKE_HERDR)
        names = (["systemctl", "systemd-run", "loginctl", "busctl"] if systemd_tools else []) + ["journalctl"] + (["crontab"] if crontab else [])
        for name in names: self.tool(name, FAKE_TOOL)
        self.put("systemd", systemd); self.put("linger", linger)
        self.env = patch.dict(os.environ, {"HOME": str(self.home), "XDG_CONFIG_HOME": str(self.home / ".config"),
                                           "PATH": str(self.bin) + (":/usr/bin:/bin" if system_path else "")}, clear=False)
        self.homepatch = patch.object(bridge.Path, "home", return_value=self.home)
        self.platform = patch.object(bridge.sys, "platform", "linux")

    def tool(self, name, text):
        path = self.bin / name
        path.write_text(text.replace("#!/usr/bin/env python3", "#!" + sys.executable, 1))
        path.chmod(0o755)

    def put(self, key, value):
        (self.home / "fake").mkdir(exist_ok=True)
        (self.home / "fake" / key).write_text(value)

    def herdr_state(self, **st):
        self.put("herdr.json", json.dumps(dict({"running": False}, **st)))

    def get_state(self):
        return json.loads((self.home / "fake" / "herdr.json").read_text())

    def log(self, text):
        folder = self.home / ".config/herdr"
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / "herdr-server.log", "a") as f: f.write(text)

    def calls(self, name=None):
        try: rows = [json.loads(x) for x in (self.home / "calls.log").read_text().splitlines()]
        except OSError: return []
        return [r for r in rows if name is None or r[0] == name]

    def __enter__(self):
        self.env.start(); self.homepatch.start(); self.platform.start()
        G["_log_cache"].clear(); G["_oom_cache"].clear()
        return self

    def __exit__(self, *exc):
        self.platform.stop(); self.homepatch.stop(); self.env.stop()
        self.tmp.cleanup()


def never_stops(test, fake):
    """No command that could stop, restart or signal a Herdr server ran."""
    for row in fake.calls():
        test.assertNotIn(["herdr", "server", "stop"], [row[:3]])
        if row[0] == "systemctl":
            test.assertFalse(any("herdr-pocket-server" in a for a in row), row)
            if "stop" in row or "kill" in row or "restart" in row or "disable" in row:
                test.assertIn("herdr-pocket-guard.service", row, row)


class LogTests(unittest.TestCase):
    def test_runs_clean_and_unclean(self):
        with Fake() as f:
            f.log(startup("2026-10-01T10:00:00.5Z", 11) + shutdown("2026-10-01T11:00:00Z", 11) +
                  startup("2026-10-02T10:00:00.000001Z", 22) + "2026-10-02T12:00:00Z  INFO x\n")
            runs = G["log_runs"](G["log_path"](), want=2)
        self.assertEqual([r["pid"] for r in runs], [11, 22])
        self.assertTrue(runs[0]["clean"])
        self.assertFalse(runs[1]["clean"])
        self.assertAlmostEqual(runs[1]["last"] - runs[1]["started"], 7200, delta=1)
        self.assertAlmostEqual(runs[0]["ended"] - runs[0]["started"], 3599.5, delta=0.01)

    def test_shutdown_of_another_pid_is_not_clean(self):
        with Fake() as f:
            f.log(startup("2026-10-01T10:00:00Z", 11) + shutdown("2026-10-01T11:00:00Z", 99))
            self.assertFalse(G["log_runs"](G["log_path"]())[-1]["clean"])

    def test_reads_backwards_across_chunks(self):
        with Fake() as f:
            f.log(startup("2026-10-01T10:00:00Z", 7) + "".join("2026-10-01T10:%02d:00Z  INFO api request completed %s\n" % (i % 60, "x" * 80) for i in range(3000)))
            runs = G["log_runs"](G["log_path"](), want=1, chunk=4096)
        self.assertEqual(runs[-1]["pid"], 7)

    def test_missing_log(self):
        with Fake():
            self.assertIsNone(G["log_runs"](G["log_path"]()))

    def test_memory_kill_evidence(self):
        with Fake() as f:
            run = {"pid": 4242, "started": time.time() - 100, "clean": False}
            self.assertFalse(G["memory_kill"](run))
            G["_oom_cache"].clear(); f.put("journal", "Oct 18 kernel: Out of memory: Killed process 4242 (herdr) total-vm:1kB\n")
            self.assertEqual(G["memory_kill"](run)["source"], "kernel")
            G["_oom_cache"].clear(); f.put("journal", "Oct 18 kernel: Out of memory: Killed process 4242 (python) total-vm:1kB\n")
            self.assertFalse(G["memory_kill"](run), "another process that had the same pid")
            G["_oom_cache"].clear(); f.put("journal", "earlyoom[9]: sending SIGTERM to process 4242 uid 1000 \"herdr\"\n")
            self.assertEqual(G["memory_kill"](run)["source"], "earlyoom")
            G["_oom_cache"].clear(); f.put("journal", "systemd-oomd[1]: Killed /user.slice/app.slice/app-term.scope due to memory pressure\n")
            self.assertFalse(G["memory_kill"](run))
            self.assertEqual(G["memory_kill"](run, "/user.slice/app.slice/app-term.scope")["source"], "systemd-oomd")


class GuardTickTests(unittest.TestCase):
    def cfg(self, f, **kw):
        return dict({"herdr": str(f.bin / "herdr"), "boot": False, "always": False, "method": "detached", "since": time.time() - 3600}, **kw)

    def test_running_server_is_left_alone(self):
        with Fake() as f:
            f.herdr_state(running=True)
            f.log(startup(iso(time.time() - 60), 31))
            st = G["load_state"]()
            self.assertEqual(G["tick"](self.cfg(f), st, first=True), "running")
            self.assertEqual(st["seen"]["pid"], 31)
            self.assertEqual([r for r in f.calls("herdr") if r[1:] == ["server"]], [])
            never_stops(self, f)

    def test_crash_is_restarted_once(self):
        with Fake() as f:
            f.herdr_state(running=False)
            f.log(startup(iso(time.time() - 600), 31))
            st = G["load_state"]()
            self.assertEqual(G["tick"](self.cfg(f), st, first=True), "started")
            self.assertTrue(f.get_state()["running"])
            self.assertEqual(st["events"][-1]["what"], "started")
            self.assertEqual(st["events"][-1]["reason"], "crash")
            self.assertEqual(len([r for r in f.calls("herdr") if r[1:] == ["server"]]), 1)
            # The started server is up: nothing more happens.
            self.assertEqual(G["tick"](self.cfg(f), G["load_state"](), first=True), "running")
            never_stops(self, f)

    def test_oom_kill_is_named(self):
        with Fake() as f:
            f.herdr_state(running=False)
            f.log(startup(iso(time.time() - 600), 4242))
            G["_oom_cache"].clear(); f.put("journal", "kernel: Out of memory: Killed process 4242 (herdr) total-vm:1kB\n")
            st = G["load_state"]()
            G["tick"](self.cfg(f), st, first=True)
            self.assertEqual(st["events"][-1]["reason"], "oom")
            self.assertEqual(st["events"][-1]["oom"], "kernel")

    def test_clean_stop_is_respected_and_remembered(self):
        with Fake() as f:
            f.herdr_state(running=False)
            now = time.time()
            f.log(startup(iso(now - 600), 31) + shutdown(iso(now - 30), 31))
            st = G["load_state"]()
            self.assertEqual(G["tick"](self.cfg(f), st, first=True), "left")
            self.assertEqual(st["handled_reason"], "stopped")
            # A later login (guard starts again, --boot) leaves it too.
            self.assertEqual(G["tick"](self.cfg(f, boot=True, since=time.time()), G["load_state"](), first=True), "left")
            self.assertFalse(f.get_state()["running"])
            # --always starts it.
            self.assertEqual(G["tick"](self.cfg(f, always=True), G["load_state"](), first=True), "started")

    def test_boot_option(self):
        with Fake() as f:
            f.herdr_state(running=False)
            f.log(startup(iso(time.time() - 7200), 31) + shutdown(iso(time.time() - 3600), 31))
            since = time.time() - 60  # the guard started after that clean stop (a login, a boot)
            self.assertEqual(G["tick"](self.cfg(f, since=since), G["load_state"](), first=True), "left")
            self.assertNotIn("handled", G["load_state"](), "not --boot: nothing remembered, @reboot may still start it")
            self.assertEqual(G["tick"](self.cfg(f, since=since, boot=True), G["load_state"](), first=True), "started")

    def test_ended_before_boot_counts_as_boot(self):
        with Fake() as f:
            f.herdr_state(running=False)
            f.log(startup(iso(time.time() - 7200), 31) + shutdown(iso(time.time() - 3600), 31))
            with patch.dict(G, {"boot_time": lambda: time.time() - 1800}):
                # The clean stop happened while "watching" but before this boot: the reboot ended it.
                self.assertEqual(G["judge"](G["log_runs"](G["log_path"]())[-1], time.time() - 7000, time.time() - 1800, None)[0], "before")

    def test_backoff_while_it_keeps_dying(self):
        with Fake() as f:
            f.herdr_state(running=False)
            f.log(startup(iso(time.time() - 600), 31))
            st = G["load_state"]()
            G["tick"](self.cfg(f), st, first=True)
            f.herdr_state(running=False)  # died at once
            st = G["load_state"]()
            self.assertEqual(G["tick"](self.cfg(f), st, first=True), "waiting")
            self.assertGreater(st["next"], time.time() + 5)
            st["next"] = 0; G["save_state"](st)
            self.assertEqual(G["tick"](self.cfg(f), G["load_state"](), first=True), "started")
            st = G["load_state"]()
            self.assertEqual(st["fails"], 2)
            self.assertGreater(st["next"] - st["last_start"], 20)

    def test_socket_still_held_means_no_second_server(self):
        with Fake() as f:
            f.herdr_state(running=False)
            f.log(startup(iso(time.time() - 600), 31))
            with patch.dict(G, {"listening": lambda path: True}):
                self.assertEqual(G["tick"](self.cfg(f), G["load_state"](), first=True), "starting")
                self.assertEqual(G["start"](str(f.bin / "herdr"), "detached")["busy"], True)
            self.assertEqual([r for r in f.calls("herdr") if r[1:] == ["server"]], [])

    def test_start_refuses_when_running(self):
        with Fake() as f:
            f.herdr_state(running=True)
            self.assertTrue(G["start"](str(f.bin / "herdr"), "detached")["already"])
            self.assertEqual([r for r in f.calls("herdr") if r[1:] == ["server"]], [])

    def test_systemd_start_is_its_own_unit_with_oom_floor(self):
        with Fake() as f:
            f.herdr_state(running=False)
            with patch.dict(os.environ, {"HERDR_SOCKET_PATH": "/x", "SSH_CONNECTION": "1 2 3 4", "LANG": "C.UTF-8"}):
                r = G["start"](str(f.bin / "herdr"), "systemd", oom=100)
            self.assertTrue(r["started"]); self.assertTrue(r["running"])
            run = f.calls("systemd-run")[0]
            self.assertIn("--unit=herdr-pocket-server", run)
            self.assertIn("--collect", run)
            self.assertIn("OOMScoreAdjust=100", run)
            self.assertEqual(run[run.index("--") + 1:], [str(f.bin / "herdr"), "server"])
            self.assertTrue(any(a.startswith("--setenv=PATH=") for a in run))
            self.assertIn("--setenv=LANG=C.UTF-8", run)
            self.assertFalse(any("HERDR_" in a or "SSH_" in a for a in run))

    def test_detached_env_drops_herdr_and_ssh_variables(self):
        with Fake() as f, patch.dict(os.environ, {"HERDR_SOCKET_PATH": "/x", "SSH_TTY": "/dev/pts/1"}):
            env = G["clean_env"](str(f.bin / "herdr"))
        self.assertNotIn("HERDR_SOCKET_PATH", env)
        self.assertNotIn("SSH_TTY", env)
        self.assertIn(str(f.bin), env["PATH"].split(":"))
        self.assertIn(str(f.home / ".local/bin"), env["PATH"].split(":"))

    def test_script_runs_standalone_once(self):
        with Fake() as f:
            f.herdr_state(running=False)
            f.log(startup(iso(time.time() - 600), 31))
            script = Path(f.tmp.name) / "herdr-guard.py"
            script.write_text(bridge.GUARD_SCRIPT)
            out = subprocess.run([sys.executable, "-I", str(script), "--once", "--herdr", str(f.bin / "herdr")],
                                 capture_output=True, text=True, timeout=30, env=dict(os.environ))
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertTrue(f.get_state()["running"])
            events = json.loads((f.home / ".local/state/herdr-pocket/guard-v1.json").read_text())["events"]
            self.assertEqual(events[-1]["what"], "started")
            self.assertEqual(oct((f.home / ".local/state/herdr-pocket/guard-v1.json").stat().st_mode & 0o777), "0o600")
            bad = subprocess.run([sys.executable, "-I", str(script), "--nope"], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(bad.returncode, 0)


class PlanAndSetTests(unittest.TestCase):
    def plan(self, **kw):
        return bridge.handle(dict({"v": 1, "op": "guardPlan"}, **kw))

    def test_systemd_plan_shows_exact_files(self):
        with Fake() as f:
            plan = self.plan()
            self.assertEqual(plan["kind"], "systemd")
            paths = [x["path"] for x in plan["files"]]
            self.assertEqual(paths, [str(f.home / ".herdr-pocket/guard/herdr-guard.py"), str(f.home / ".config/systemd/user/herdr-pocket-guard.service")])
            self.assertEqual(plan["files"][0]["content"], bridge.GUARD_SCRIPT)
            unit = plan["files"][1]["content"]
            self.assertIn("KillMode=process", unit)
            self.assertIn("--watch --herdr " + str(f.bin / "herdr") + " --boot", unit)
            self.assertIn("WantedBy=default.target", unit)
            self.assertEqual(plan["oom"], {"floor": 100, "default": 200, "set": 100})
            self.assertFalse(plan["linger"])
            self.assertNotIn("--always", unit)
            self.assertIn("--always", self.plan(always=True)["files"][1]["content"])
            self.assertNotEqual(self.plan(always=True)["digest"], plan["digest"])
            self.assertEqual(self.plan()["digest"], plan["digest"])
            self.assertEqual(f.calls("herdr"), [], "planning runs nothing of Herdr")

    def test_oom_floor_not_below_default_is_not_set(self):
        with Fake() as f:
            f.put("floor", "200")
            self.assertIsNone(self.plan()["oom"]["set"])

    def test_cron_plan_without_systemd(self):
        with Fake(systemd="offline") as f:
            plan = self.plan()
            self.assertEqual(plan["kind"], "cron")
            self.assertEqual(len(plan["cron"]), 2)
            self.assertTrue(plan["cron"][0].startswith("@reboot "))
            self.assertTrue(all(x.endswith(bridge.CRON_MARK) and ">/dev/null 2>&1" in x for x in plan["cron"]))
            self.assertEqual(len(self.plan(boot=False)["cron"]), 1)

    def test_unsupported(self):
        with Fake(systemd="offline", crontab=False, system_path=False):
            plan = self.plan()
            self.assertFalse(plan["supported"])
            self.assertIn("crontab", plan["reason"])
        with Fake(), patch.object(bridge.sys, "platform", "darwin"):
            plan = self.plan()
            self.assertFalse(plan["supported"])
            self.assertIn("macOS", plan["reason"])

    def test_systemd_quote(self):
        self.assertEqual(bridge.systemd_quote("/home/a/b.py"), "/home/a/b.py")
        self.assertEqual(bridge.systemd_quote("/home/a b/x%y$z"), '"/home/a b/x%%y$$z"')
        self.assertEqual(bridge.systemd_quote('a"b\\c'), '"a\\"b\\\\c"')

    def test_install_and_remove_systemd(self):
        with Fake() as f:
            f.herdr_state(running=True)
            plan = self.plan()
            with self.assertRaises(bridge.BridgeError) as caught:
                bridge.handle({"v": 1, "op": "guardSet", "id": UUID, "enable": True, "digest": "0" * 64}, f.home / "state")
            self.assertIn("不一样", str(caught.exception))
            self.assertFalse((f.home / ".config/systemd/user/herdr-pocket-guard.service").exists())
            result = bridge.handle({"v": 1, "op": "guardSet", "id": UUID, "enable": True, "digest": plan["digest"]}, f.home / "state")
            self.assertTrue(result["enabled"]); self.assertTrue(result["active"])
            unit = f.home / ".config/systemd/user/herdr-pocket-guard.service"
            self.assertEqual(unit.read_text(), plan["files"][1]["content"])
            script = f.home / ".herdr-pocket/guard/herdr-guard.py"
            self.assertEqual(script.read_text(), bridge.GUARD_SCRIPT)
            self.assertEqual(stat.S_IMODE(script.stat().st_mode), 0o600)
            self.assertEqual([c[1:] for c in f.calls("systemctl") if c[2] in ("daemon-reload", "enable", "restart")],
                             [["--user", "daemon-reload"], ["--user", "enable", "herdr-pocket-guard.service"], ["--user", "restart", "herdr-pocket-guard.service"]])
            # The same id again returns the stored result and runs nothing.
            n = len(f.calls())
            again = bridge.handle({"v": 1, "op": "guardSet", "id": UUID, "enable": True, "digest": plan["digest"]}, f.home / "state")
            self.assertEqual(again["enabled"], True)
            self.assertFalse(any(c[:3] == ["systemctl", "--user", "enable"] for c in f.calls()[n:]))
            status = bridge.handle({"v": 1, "op": "herdrHealth"})["guard"]
            self.assertTrue(status["installed"]); self.assertTrue(status["active"]); self.assertTrue(status["boot"])
            self.assertFalse(status["outdated"])
            # 关闭守护: only the watcher stops; Herdr keeps running.
            off = bridge.handle({"v": 1, "op": "guardSet", "id": UUID2, "enable": False}, f.home / "state")
            self.assertFalse(off["enabled"])
            self.assertFalse(unit.exists()); self.assertFalse(script.exists())
            self.assertIn(["systemctl", "--user", "disable", "--now", "herdr-pocket-guard.service"], f.calls("systemctl"))
            self.assertTrue(f.get_state()["running"])
            never_stops(self, f)

    def test_foreign_unit_is_never_overwritten(self):
        with Fake() as f:
            unit = f.home / ".config/systemd/user/herdr-pocket-guard.service"
            unit.parent.mkdir(parents=True); unit.write_text("[Service]\nExecStart=/bin/true\n")
            plan = self.plan()
            with self.assertRaises(bridge.BridgeError) as caught:
                bridge.handle({"v": 1, "op": "guardSet", "id": UUID, "enable": True, "digest": plan["digest"]}, f.home / "state")
            self.assertIn("不是 Herdr Pocket 写的", str(caught.exception))
            self.assertEqual(unit.read_text(), "[Service]\nExecStart=/bin/true\n")
            bridge.handle({"v": 1, "op": "guardSet", "id": UUID2, "enable": False}, f.home / "state")
            self.assertTrue(unit.exists(), "关闭守护 leaves a unit it did not write")

    def test_failed_enable_rolls_back(self):
        with Fake() as f:
            f.put("fail_enable", "1")
            plan = self.plan()
            with self.assertRaises(bridge.BridgeError) as caught:
                bridge.handle({"v": 1, "op": "guardSet", "id": UUID, "enable": True, "digest": plan["digest"]}, f.home / "state")
            self.assertIn("没开", str(caught.exception))
            self.assertFalse((f.home / ".config/systemd/user/herdr-pocket-guard.service").exists())
            self.assertFalse((f.home / ".herdr-pocket/guard/herdr-guard.py").exists())

    def test_cron_install_keeps_other_lines(self):
        with Fake(systemd="offline") as f:
            f.put("crontab", "0 3 * * * backup.sh\n")
            plan = self.plan()
            bridge.handle({"v": 1, "op": "guardSet", "id": UUID, "enable": True, "digest": plan["digest"]}, f.home / "state")
            text = (f.home / "fake/crontab").read_text()
            self.assertTrue(text.startswith("0 3 * * * backup.sh\n"))
            self.assertEqual([x for x in text.splitlines() if bridge.CRON_MARK in x], plan["cron"])
            status = bridge.guard_status()
            self.assertEqual(status["kind"], "cron"); self.assertTrue(status["installed"])
            bridge.handle({"v": 1, "op": "guardSet", "id": UUID2, "enable": False}, f.home / "state")
            self.assertEqual((f.home / "fake/crontab").read_text(), "0 3 * * * backup.sh\n")

    def test_guard_set_needs_uuid(self):
        with Fake() as f:
            with self.assertRaises(bridge.BridgeError):
                bridge.handle({"v": 1, "op": "guardSet", "enable": False}, f.home / "state")


class HealthAndStartTests(unittest.TestCase):
    def test_health_running_names_previous_end(self):
        with Fake() as f:
            f.herdr_state(running=True)
            now = time.time()
            f.log(startup(iso(now - 900), 11) + startup(iso(now - 300), 22))
            G["_oom_cache"].clear(); f.put("journal", "kernel: Out of memory: Killed process 11 (herdr) total-vm:1kB\n")
            h = bridge.handle({"v": 1, "op": "herdrHealth"})
            self.assertEqual(h["server"]["state"], "running")
            self.assertEqual(h["server"]["pid"], 22)
            self.assertEqual(h["server"]["previous"]["how"], "oom")
            self.assertNotIn("socket", h["server"], "no server paths to the phone")

    def test_health_stopped_crash_and_mismatch(self):
        with Fake() as f:
            f.herdr_state(running=False)
            f.log(startup(iso(time.time() - 900), 11))
            h = bridge.handle({"v": 1, "op": "herdrHealth"})
            self.assertEqual(h["server"]["state"], "stopped")
            self.assertEqual(h["server"]["ended"]["how"], "crash")
            self.assertEqual(h["start"]["method"], "detached")
            self.assertFalse(h["start"]["kill_user_processes"])
            f.herdr_state(running=True, compatible=False, version="0.9.5")
            self.assertEqual(bridge.handle({"v": 1, "op": "herdrHealth"})["server"]["state"], "mismatch")

    def test_start_detached_then_refuses_when_running(self):
        with Fake() as f:
            f.herdr_state(running=False)
            r = bridge.handle({"v": 1, "op": "herdrStart", "id": UUID}, f.home / "state")
            self.assertTrue(r["started"]); self.assertTrue(r["running"]); self.assertEqual(r["method"], "detached")
            self.assertEqual(f.calls("systemd-run"), [], "no linger: not a user unit (it would die with the last login)")
            # The same id: the stored result, not a second start.
            self.assertEqual(bridge.handle({"v": 1, "op": "herdrStart", "id": UUID}, f.home / "state")["started"], True)
            self.assertEqual(len([r for r in f.calls("herdr") if r[1:] == ["server"]]), 1)
            with self.assertRaises(bridge.BridgeError) as caught:
                bridge.handle({"v": 1, "op": "herdrStart", "id": UUID2}, f.home / "state")
            self.assertIn("已经在运行", str(caught.exception))
            never_stops(self, f)

    def test_start_with_linger_is_a_user_unit(self):
        with Fake(linger="yes") as f:
            f.herdr_state(running=False)
            r = bridge.handle({"v": 1, "op": "herdrStart", "id": UUID}, f.home / "state")
            self.assertEqual(r["method"], "systemd")
            self.assertEqual(r["unit"], "herdr-pocket-server.service")
            self.assertIn("OOMScoreAdjust=100", f.calls("systemd-run")[0])

    def test_start_needs_uuid(self):
        with Fake() as f:
            f.herdr_state(running=False)
            with self.assertRaises(bridge.BridgeError):
                bridge.handle({"v": 1, "op": "herdrStart"}, f.home / "state")
            self.assertFalse(f.get_state()["running"])

    def test_sessions_report_which_run_is_up(self):
        with Fake() as f:
            f.herdr_state(running=True)
            f.log(startup(iso(time.time() - 60), 77))
            r = bridge.handle({"v": 1, "op": "sessions"})
            self.assertEqual(r["server"]["pid"], 77)
            f.herdr_state(running=False)
            self.assertNotIn("server", bridge.handle({"v": 1, "op": "sessions"}))

    def test_doctor_reports_server_state(self):
        with Fake() as f:
            f.herdr_state(running=False)
            d = bridge.handle({"v": 1, "op": "doctor"})
            self.assertEqual(d["running"], 0)
            self.assertEqual(d["server"]["state"], "stopped")


if __name__ == "__main__":
    unittest.main()
