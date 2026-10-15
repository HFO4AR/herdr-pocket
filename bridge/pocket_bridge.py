#!/usr/bin/env python3
"""Herdr Pocket protocol v1. One bounded JSON request over SSH stdin."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import sqlite3
import subprocess
import sys
import time
import stat as stat_module
from urllib.parse import quote as uri_quote
from contextlib import closing

VERSION = "0.6.0"
LIMIT = 65536


# Keys the phone may press in an agent pane. "shift+tab" is Herdr's name for Back-Tab (ESC [ Z).
AGENT_KEYS = ("up", "down", "left", "right", "enter", "esc", "ctrl+c", "shift+tab")


class BridgeError(Exception):
    pass


class HerdrRejected(BridgeError):
    """Herdr answered with a structured error code instead of performing the request."""
    def __init__(self, code, message):
        super().__init__((code + ": " + message)[:2000])
        self.code, self.detail = code, message


# Herdr checks these before writing anything to the pane, so the input was not sent.
NOT_SENT = {
    "agent_blocked": "没发出去：Agent 正停在一个提问或授权框上，先处理它（看不清就点“用按键操作”看屏幕）",
    "agent_not_found": "没发出去：这个窗格里找不到这个 Agent 了，回到列表刷新一下",
    "agent_not_ready": "没发出去：Agent 还没准备好，等它空闲了再发",
    "pane_not_found": "没发出去：这个窗格已经不在了，回到列表刷新一下",
}


def herdr_error(raw):
    try: value = json.loads(raw).get("error")
    except (ValueError, AttributeError): return None
    if isinstance(value, dict) and isinstance(value.get("code"), str):
        return HerdrRejected(value["code"], str(value.get("message", "")))
    return None


def call(args, timeout=20):
    binary = shutil.which("herdr") or str(Path.home() / ".local/bin/herdr")
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERDR_")}
    try:
        result = subprocess.run([binary, *args], capture_output=True, text=True,
                                timeout=timeout, env=env)
    except subprocess.TimeoutExpired as exc:
        raise BridgeError("Herdr timeout; mutation outcome may be unknown. Do not resend blindly.") from exc
    except OSError as exc:
        raise BridgeError("电脑上没找到 Herdr（这个 SSH 用户的 PATH 和 ~/.local/bin 里都没有）。装好 Herdr 再刷新。") from exc
    if result.returncode:
        raise herdr_error(result.stdout) or herdr_error(result.stderr) or BridgeError((result.stderr or result.stdout or "Herdr command failed")[:2000])
    # Herdr 0.8.x agent read emits plain text, while list/control emit JSON.
    command_args = args[2:] if args[:1] == ["--session"] else args
    if command_args[:2] in (["agent", "read"], ["pane", "read"]):
        return {"text": result.stdout}
    # Herdr 0.8.x pane input commands succeed silently: exit 0 and no output. Reading that as a
    # failure marked delivered messages "outcome unknown" (the text had already reached the pane).
    if command_args[:2] in (["pane", "run"], ["pane", "send-text"], ["pane", "send-keys"]) and not result.stdout.strip():
        return {"type": "ok"}
    try:
        data = json.loads(result.stdout)
    except ValueError as exc:
        raise BridgeError("Herdr returned non-JSON output; check CLI compatibility.") from exc
    if data.get("error"):
        raise herdr_error(result.stdout) or BridgeError(str(data["error"])[:2000])
    return data.get("result", data)


def identity(agent):
    # 绑定具体终端及 Agent 会话，避免面板换人后把消息发错。
    fields = {k: agent.get(k) for k in ("terminal_id", "agent", "agent_session")}
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()


def herdr_binary():
    found = shutil.which("herdr")
    if found: return found
    fallback = Path.home() / ".local/bin/herdr"
    return str(fallback) if fallback.is_file() and os.access(fallback, os.X_OK) else None


def doctor():
    """Read-only first-run check: is Herdr installed for this user, and is any session running?"""
    import platform
    result = {"python": platform.python_version(), "herdr": herdr_binary() is not None, "running": None}
    if result["herdr"]:
        try: result["running"] = sum(1 for s in sessions() if s.get("running"))
        except BridgeError as exc: result["error"] = str(exc)[:300]
    return result


def sessions():
    return call(["session", "list", "--json"]).get("sessions", [])


def select_session(request):
    name = request.get("session")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", name):
        raise BridgeError("Invalid session name")
    # --session can create a session: only invoke it after checking an existing live session.
    if not any(s.get("name") == name and s.get("running") for s in sessions()):
        raise BridgeError("Session is offline or no longer exists")
    return ["--session", name]


def agents(prefix, include_history=False):
    found = call(prefix + ["agent", "list"]).get("agents", [])
    result = [dict(a, identity=identity(a)) for a in found]
    if not include_history: return result
    global _remote_deadline
    _remote_deadline = time.monotonic() + 20
    _remote_results.clear()
    live = [a for a in result if a.get("agent") in ("codex", "claude")]
    probes = {a["pane_id"]: probe_pane(a, prefix, a["agent"]) for a in live}
    prefetch_remote([(probes[a["pane_id"]]["route"], a["agent"]) for a in live if probes[a["pane_id"]]["route"]])
    catalog = transcript_catalog() if live else []
    codex_index = (codex_thread_names(), codex_loaded_threads()) if any(a["agent"] == "codex" for a in live) else None
    for agent in live:
        agent["history_ref"] = resolve_agent_history(agent, prefix, catalog, codex_index, probes[agent["pane_id"]])
    return result


def panes(prefix):
    found = []
    workspaces = call(prefix + ["workspace", "list"]).get("workspaces", [])
    for workspace in workspaces:
        for pane in call(prefix + ["pane", "list", "--workspace", workspace["workspace_id"]]).get("panes", []):
            if pane.get("agent") or not pane.get("terminal_id"): continue
            found.append(dict(pane, identity=identity(pane), workspace_label=workspace.get("label", "")))
    return found


def relay_pane(agent, prefix):
    """A ch pane: the agent runs on another computer behind a local relay, so the pane's foreground
    process is the relay, not the agent. Herdr's agent commands refuse such a pane (agent_not_ready:
    "no longer the pane foreground process") although it lists the agent; input has to go to the
    pane itself. Decided before anything is written, from the process tree only."""
    if agent.get("agent") not in ("claude", "codex"): return False
    probe = probe_pane(agent, prefix, agent["agent"])
    return bool(probe["ok"] and probe["route"] and not probe.get("native"))


def read_screen(prefix, agent, lines):
    """The agent's screen. A blocked full-screen agent (a ch pane's remote Claude, for one) cannot have
    its history scrolled back, and Herdr says so (agent_not_idle): the visible screen holds the menu
    anyway. A ch pane that Herdr's agent commands refuse is read at the pane level."""
    target = agent["pane_id"]
    try: return call(prefix + ["agent", "read", target, "--source", "recent-unwrapped", "--lines", str(lines)])
    except HerdrRejected as exc:
        if exc.code == "agent_not_idle": return call(prefix + ["agent", "read", target, "--source", "visible"])
        if exc.code == "agent_not_ready" and relay_pane(agent, prefix):
            try: return call(prefix + ["pane", "read", target, "--source", "recent-unwrapped", "--lines", str(lines)])
            except HerdrRejected: return call(prefix + ["pane", "read", target, "--source", "visible"])
        raise


def relay_prompt(prefix, pane_id, text):
    """Type a prompt into a relay pane. One line: `pane run` (text, then Enter). Several lines go in
    as one bracketed paste, so the agent's input box keeps the line breaks, then Enter submits."""
    if "\n" not in text and "\r" not in text: return call(prefix + ["pane", "run", pane_id, text])
    call(prefix + ["pane", "send-text", pane_id, "\x1b[200~" + text.replace("\r\n", "\n") + "\x1b[201~"])
    time.sleep(0.15)
    return call(prefix + ["pane", "send-keys", pane_id, "enter"])


def mutate(request, prefix, agent, state_dir):
    op = request["op"]
    req_id = request.get("id", "")
    if not isinstance(req_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", req_id):
        raise BridgeError("Mutation requires a UUID request id")
    digest = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(state_dir / "receipts.sqlite", timeout=5)
    try:
        db.execute("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT, result TEXT)")
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute("SELECT digest, result FROM receipts WHERE id=?", (req_id,)).fetchone()
        if previous:
            db.rollback()
            if previous[0] != digest:
                raise BridgeError("Request id reused with different content")
            if previous[1] is None:
                raise BridgeError("Previous command outcome is unknown; inspect the agent before proceeding")
            return json.loads(previous[1])
        text = request.get("text")
        key = request.get("key")
        if op == "prompt":
            if agent.get("agent_status") not in ("idle", "done"):
                raise BridgeError("Agent is busy or waiting for confirmation; refresh and inspect it first")
            images = request.get("images")
            files = request.get("files")
            if not isinstance(text, str) or (not text.strip() and not images and not files) or len(text.encode()) > 15000 or "\x00" in text:
                raise BridgeError("Prompt must contain 1–15000 UTF-8 bytes without NUL")
            if images is not None or files is not None:
                # Checked and (for ch routes) shared before the receipt: a failure here sent nothing.
                text = compose_prompt(text, (prompt_images(images, request, prefix, agent) if images is not None else [])
                                      + (prompt_files(files, request, prefix, agent) if files is not None else []))
            args = ["agent", "prompt", agent["pane_id"], text]
        elif op == "key":
            if key not in AGENT_KEYS:
                raise BridgeError("Unsupported key")
            if key == "shift+tab":
                # Shift+Tab switches the agent's own mode. On a permission dialog Claude takes it as
                # "yes, and don't ask again", so it is only sent while no question or approval waits.
                if agent.get("agent") not in ("claude", "codex"):
                    raise BridgeError("没发出去：只有 Claude 和 Codex 能用 Shift+Tab 切换模式")
                if agent.get("agent_status") not in ("idle", "done", "working"):
                    raise BridgeError("没发出去：Agent 正等你确认，这时按 Shift+Tab 可能直接批准；先处理完再切换")
            args = ["agent", "send-keys", agent["pane_id"], key]
        elif op == "exitAgent":
            # The command is chosen here from the agent kind; the phone sends none.
            if set(request) - CLOSE_KEYS: raise BridgeError("没发出去：请求里有不认识的字段")
            command = EXIT_COMMANDS.get(agent.get("agent"))
            if not command: raise BridgeError("没发出去：不认识这个 Agent，没法让它自己退出")
            if agent.get("agent_status") not in ("idle", "done"):
                raise BridgeError("没发出去：Agent 还在干活或在等确认，先中断它再结束")
            args = ["agent", "prompt", agent["pane_id"], command]
        elif op == "answer":
            if agent.get("agent_status") != "blocked":
                raise BridgeError("Agent is not waiting on a menu; refresh and inspect it first")
            validate_answer(request)
            args = None
        elif op in ("paneRun", "paneText", "paneKey"):
            if agent.get("agent"):
                raise BridgeError("Pane now contains an Agent; reload before sending input")
            if op == "paneKey":
                if key not in ("up", "down", "left", "right", "enter", "esc", "ctrl+c", "ctrl+d", "tab", "backspace"):
                    raise BridgeError("Unsupported key")
                args = ["pane", "send-keys", agent["pane_id"], key]
            else:
                if not isinstance(text, str) or not text or len(text.encode()) > 16000 or "\x00" in text:
                    raise BridgeError("Terminal input must contain 1–16000 UTF-8 bytes without NUL")
                args = ["pane", "run" if op == "paneRun" else "send-text", agent["pane_id"], text]
        else:
            raise BridgeError("Unsupported mutation")
        # 在写入终端之前持久化请求；中断后相同 ID 也不能再次执行。
        db.execute("INSERT INTO receipts VALUES (?, ?, NULL)", (req_id, digest))
        db.commit()
        try:
            try: value = answer_question(request, prefix, agent) if op == "answer" else call(prefix + args)
            except HerdrRejected as exc:
                # Herdr refused before writing anything. A ch pane (see relay_pane) takes the same
                # input at the pane level instead: still the one and only write for this receipt.
                if not (exc.code == "agent_not_ready" and op in ("prompt", "key", "answer", "exitAgent")
                        and relay_pane(agent, prefix)): raise
                if op == "answer": value = answer_question(request, prefix, dict(agent, relay=True))
                elif op == "key": value = call(prefix + ["pane", "send-keys", agent["pane_id"], key])
                else: value = relay_prompt(prefix, agent["pane_id"], args[-1])
        except HerdrRejected as exc:
            if exc.code not in NOT_SENT: raise
            # Rejected before any input reached the pane: record why, and say it can be resent.
            db.execute("UPDATE receipts SET result=? WHERE id=?", (json.dumps({"sent": False, "rejected": exc.code}), req_id))
            db.commit()
            raise BridgeError(NOT_SENT[exc.code]) from exc
        result = {"sent": True, "receipt": req_id, "result": value}
        if op == "exitAgent": result["command"] = args[-1]
        if op == "prompt" and (request.get("images") is not None or request.get("files") is not None): result["text"] = text
        db.execute("UPDATE receipts SET result=? WHERE id=?", (json.dumps(result), req_id))
        db.commit()
        return result
    finally:
        db.close()


# Read-only, allow-listed transcript adapters. Never reads provider credentials.
def transcript_roots():
    return [("codex", Path.home() / ".codex/sessions"), ("claude", Path.home() / ".claude/projects")]



def process_snapshot(pid):
    """Only process identity, argv and FD links; never environment or file contents."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0: return None
    root = Path("/proc") / str(pid)
    try:
        before = (root / "stat").read_text().rsplit(") ", 1)[1].split()[19]
        argv = (root / "cmdline").read_bytes()[:65536].decode(errors="replace").split("\0")
        children = [int(x) for x in (root / "task" / str(pid) / "children").read_text().split()]
        paths, active_threads = [], []
        for fd in list((root / "fd").iterdir())[:256]:
            try:
                target = fd.readlink()
                if target.suffix == ".jsonl": paths.append(target)
                # Claude keeps its current native session task directory open.
                # Read the FD link only; never open task files or process environ.
                if (len(target.parts) >= 6 and target.parts[:3] == ("/", "tmp", "claude-"+str(os.getuid()))
                        and target.name == "tasks" and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", target.parent.name)):
                    active_threads.append(target.parent.name)
            except OSError: pass
        after = (root / "stat").read_text().rsplit(") ", 1)[1].split()[19]
        return {"argv": argv, "children": children, "paths": paths, "cwd": str((root / "cwd").readlink()), "start":before, "active_threads":active_threads} if before == after else None
    except (OSError, ValueError, IndexError): return None


def explicit_session_ids(argv, provider):
    """Accept native CLI session switches, not UUIDs from arbitrary commands/prompts."""
    if not argv or Path(argv[0]).name not in (provider, provider + ".exe"): return set()
    switches = {"resume"} if provider == "codex" else {"--resume", "-r", "--session-id"}
    ids = set()
    for i, arg in enumerate(argv):
        value = argv[i + 1] if arg in switches and i + 1 < len(argv) else ""
        if provider == "claude" and arg.startswith(("--resume=", "--session-id=")): value = arg.split("=", 1)[1]
        if re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", value): ids.add(value)
    return ids


UUID_RE = r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"


def codex_thread_names():
    """Thread id -> latest user-visible name; names only, never conversation content."""
    names, path = {}, Path.home() / ".codex/session_index.jsonl"
    try:
        with path.open("rb") as stream:
            stream.seek(max(0, path.stat().st_size - 4_000_000))
            for line in stream:
                try: row = json.loads(line)
                except (ValueError, UnicodeError): continue
                if isinstance(row, dict) and isinstance(row.get("id"), str) and isinstance(row.get("thread_name"), str):
                    names[row["id"]] = row["thread_name"].strip()
    except OSError: pass
    return names


def codex_loaded_threads():
    """Threads the Codex app-server currently has open (lock file names only)."""
    try: return {x.stem for x in (Path.home() / ".codex/thread-writer-locks").glob("*.lock") if re.fullmatch(UUID_RE, x.stem)}
    except OSError: return set()


def codex_title_threads(agent, candidates, names, loaded):
    """Codex TUI titles are "<thread name> | <cwd name>"; match only unique, open, root threads."""
    title = (agent.get("terminal_title_stripped") or agent.get("terminal_title") or "").strip()
    if not title: return set()
    base = Path(agent.get("foreground_cwd") or agent.get("cwd") or "").name
    roots = {x["thread"] for x in candidates if not x.get("parent")}
    hits = {t for t, name in names.items() if name and t in roots and title in (name + " | " + base, name)}
    open_hits = hits & loaded
    return open_hits or (hits if len(hits) == 1 else set())


def probe_pane(agent, prefix, provider):
    """Walk the pane's process tree once; read argv, cwd and FD link names only."""
    found = {"ids": set(), "paths": set(), "active": set(), "route": None, "cwd": "", "remote": False, "ok": False}
    try: info = call(prefix + ["pane", "process-info", "--pane", agent["pane_id"]]).get("process_info", {})
    except BridgeError: return found
    found["ok"] = True
    queue = [(p.get("pid"), p.get("argv", [])) for p in info.get("foreground_processes", [])]
    seen = set()
    while queue and len(seen) < 64:
        pid, initial_argv = queue.pop(0)
        if not isinstance(pid, int) or pid in seen: continue
        seen.add(pid)
        snapshot = process_snapshot(pid)
        argv = snapshot["argv"] if snapshot else initial_argv
        found["remote"] = found["remote"] or bool(argv and Path(argv[0]).name in ("ssh", "mosh", "mosh-client"))
        found["route"] = found["route"] or ch_ssh_route(argv)
        native = bool(argv and Path(argv[0]).name in (provider, provider + ".exe"))
        found["native"] = found.get("native", False) or native
        if native:
            found["ids"].update(explicit_session_ids(argv, provider))
            if snapshot:
                found["cwd"] = found["cwd"] or snapshot.get("cwd", "")
                found["paths"].update(snapshot["paths"])
                if provider == "claude": found["active"].update(snapshot.get("active_threads", []))
            # A nested agent belongs to its parent, not to this pane.
            continue
        if snapshot: queue.extend((child, []) for child in snapshot["children"])
    return found


def matched(entry, source):
    return {"status": "matched", "record_id": entry["id"], "thread": entry["thread"], "source": source}


def resolve_agent_history(agent, prefix, catalog, codex_index=None, probe=None):
    """Strongest evidence first; a weaker source never overrides a stronger one."""
    provider = agent["agent"]
    candidates = [x for x in catalog if x["provider"] == provider]
    roots = {}
    for x in candidates:  # catalog is newest first; keep the newest rollout per thread
        if not x.get("parent"): roots.setdefault(x["thread"], x)
    probe = probe or probe_pane(agent, prefix, provider)
    value = (agent.get("agent_session") or {}).get("value")
    herdr = {x["thread"] for x in candidates if value and (x["thread"] == value or str(x["_path"]) == value)}
    title = codex_title_threads(agent, candidates, *(codex_index or ({}, set()))) if provider == "codex" else set()
    fds = {x["thread"] for x in candidates if x["_path"] in probe["paths"]}
    conflict = set()
    for source, threads in (("native-process", probe["active"]), ("title", title), ("open-file", fds),
                            ("herdr", herdr), ("process", probe["ids"])):
        if len(threads) == 1:
            thread = next(iter(threads))
            if thread in roots: return matched(roots[thread], source)
            if source == "native-process" and not probe["route"]:
                return {"status": "pending", "thread": thread, "source": source, "reason": "会话刚开始，历史文件还没写出"}
        elif len(threads) > 1:
            conflict = conflict or threads
            if source in ("native-process", "title"): break
    route = probe["route"]
    if route:
        context = {"session": prefix[1] if len(prefix) > 1 else "default", "target": agent["pane_id"],
                   "identity": agent.get("identity", identity(agent)), "provider": provider}
        return remote_resolution(route, context)
    cwd = probe["cwd"] or agent.get("foreground_cwd") or agent.get("cwd") or ""
    if conflict:
        status, pool = "ambiguous", [roots[t] for t in conflict if t in roots]
    else:
        status = "remote" if probe["remote"] else "missing" if value or probe["ids"] else "unavailable"
        pool = [x for x in roots.values() if cwd and x["cwd"] == cwd]
    reason = {"remote": "这个窗格通过 SSH 连到别的电脑，无法定位那边的历史",
              "ambiguous": "找到多段可能的会话，请选择正确的一段",
              "missing": "会话标识已知，但没找到对应的历史文件",
              "unavailable": "没有能唯一确认的会话标识，请从同目录的历史里选择" if pool else "没有能确认的会话标识"}[status]
    return {"status": status, "query": cwd, "candidates": [public_record(x) for x in pool][:12], "reason": reason}


def ch_ssh_route(argv):
    """Extract only an existing live ch-cli SSH attach; never execute its command."""
    argv = [x for x in argv if x]
    if not argv or Path(argv[0]).name != "ssh": return None
    options, i = [], 1
    while i < len(argv) and argv[i].startswith("-"):
        arg = argv[i]
        if arg in ("-T", "-t", "-tt", "-N", "-n"): i += 1; continue
        if arg not in ("-p", "-i", "-S", "-l", "-J", "-o") or i+1 >= len(argv): return None
        value = argv[i+1]
        if arg != "-o" or value.split("=",1)[0].lower() in ("identitiesonly", "serveraliveinterval", "serveralivecountmax", "connectionattempts"):
            options.extend([arg,value])
        i += 2
    if len(argv) != i+2 or not argv[i] or argv[i].startswith("-"): return None
    try: command = shlex.split(argv[i+1])
    except ValueError: return None
    if command and command[0] == "exec": command = command[1:]
    if not command or Path(command[0]).name not in ("ch", "ch.route"): return None
    if len(command) == 3: command = [command[0], "--state", "~/.local/share/ch", *command[1:]]
    if len(command) != 5 or command[1] != "--state" or command[3] not in ("__native-attach", "__native-reconnect"): return None
    if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}",command[4]): return None
    state = Path(command[2].replace("$HOME/", "~/", 1))
    if not state.parts or (not state.is_absolute() and state.parts[0] != "~") or ".." in state.parts: return None
    route = {"ssh":options+[argv[i]], "workspace":str(state / "workspaces" / command[4])}
    route["key"] = hashlib.sha256(json.dumps(route,sort_keys=True).encode()).hexdigest()[:24]
    return route


_remote_results = {}
_remote_deadline = None



def route_binding_metadata(workspace):
    """Select non-secret ch route locator fields; never select full config/info."""
    workspace = Path(workspace).expanduser()
    route_id = workspace.name
    if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", route_id):
        raise BridgeError("Invalid route id")
    state = workspace.parent.parent.resolve()
    directory = state / "sessions" / route_id
    path = directory / "session.sqlite"
    if path.is_symlink() or not path.resolve().is_relative_to(state / "sessions"):
        raise BridgeError("Route metadata path is not allowed")
    fields = ("socket", "session", "pane", "pid", "start")
    expressions = ["json_extract(config, '$."+kind+"."+field+"')" for kind in ("native_route", "imported_tmux") for field in fields]
    try:
        with closing(sqlite3.connect("file:"+uri_quote(str(path))+"?mode=ro&immutable=1", uri=True, timeout=1)) as db:
            row = db.execute("SELECT "+", ".join(expressions)+" FROM session WHERE singleton=1").fetchone()
    except sqlite3.Error as exc: raise BridgeError("ch 路由定位元数据不可用") from exc
    if not row: raise BridgeError("ch 路由定位元数据缺失")
    native, imported = dict(zip(fields,row[:5])), dict(zip(fields,row[5:]))
    # ch's migration overlay contains route locators, not provider credentials.
    overlay = directory / "native-route.json"
    if overlay.exists():
        if overlay.is_symlink() or not overlay.resolve().is_relative_to(state / "sessions"):
            raise BridgeError("Route overlay path is not allowed")
        try:
            with overlay.open("rb") as stream: raw = stream.read(65537)
            if len(raw)>65536: raise ValueError()
            value=json.loads(raw).get("native_route")
            if isinstance(value,dict): native={key:value.get(key) for key in fields}
        except (OSError,ValueError,AttributeError) as exc: raise BridgeError("ch 路由定位覆盖文件异常") from exc
    binding = native if native.get("socket") else imported
    if not binding.get("socket") or not binding.get("session"): raise BridgeError("ch 路由没有原生 tmux 定位信息")
    return binding


def active_threads_in_pane(pid, provider, expected_pid=None, expected_start=None):
    queue=[pid]; seen=set(); candidates=[]; verified=expected_pid is None
    while queue and len(seen)<128:
        current=queue.pop(0)
        if current in seen: continue
        seen.add(current); snapshot=process_snapshot(current)
        if not snapshot: continue
        if current==expected_pid:
            if str(snapshot.get("start"))!=str(expected_start): raise BridgeError("导入的原生进程已更换")
            verified=True
        argv=snapshot["argv"]
        if argv and Path(argv[0]).name in (provider,provider+".exe"):
            # Runtime directory beats startup --resume after /clear or /resume.
            ids=set(snapshot.get("active_threads",[])) if provider=="claude" else set()
            if not ids: ids=explicit_session_ids(argv,provider)
            candidates.append(ids)
            # Nested agents belong to this parent, not the selected tmux pane.
            continue
        queue.extend(snapshot["children"])
    if not verified: raise BridgeError("导入的原生进程不再属于这个分屏")
    if len(candidates)!=1 or len(candidates[0])!=1: return None
    return next(iter(candidates[0]))


def remote_active_history(workspace, provider="claude"):
    try:
        binding=route_binding_metadata(workspace)
        socket=Path(binding["socket"])
        info=socket.lstat()
        if not socket.is_absolute() or not stat_module.S_ISSOCK(info.st_mode) or info.st_uid!=os.getuid():
            raise BridgeError("tmux 路由 socket 身份不符")
        session=binding["session"]
        if not isinstance(session,str) or any(c in session for c in ("\n","\r","\0")): raise BridgeError("Invalid tmux session")
        output=subprocess.run(["tmux","-S",str(socket),"list-panes","-s","-t","="+session,"-F","#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_active}\t#{window_active}"],capture_output=True,text=True,timeout=3)
        if output.returncode: raise BridgeError("远端 tmux 分屏已不可用")
        panes=[]
        for line in output.stdout.splitlines():
            fields=line.split("\t")
            if len(fields)!=5 or fields[2]!="0": continue
            if binding.get("pane"):
                if fields[0]!=binding["pane"]: continue
            elif fields[3:] != ["1","1"]: continue
            try: panes.append(int(fields[1]))
            except ValueError: continue
        if len(panes)!=1: raise BridgeError("远端活跃分屏定位不唯一")
        thread=active_threads_in_pane(panes[0],provider,binding.get("pid"),binding.get("start"))
        return {"status":"matched" if thread else "unavailable", "thread":thread, "source":"native-process"}
    except (BridgeError,OSError,subprocess.TimeoutExpired) as exc:
        return {"status":"unavailable","reason":str(exc)[:200]}



def catalog_entry(kind, root, path):
    if path.is_symlink() or not path.resolve().is_relative_to(root): return None
    stat = path.stat(); meta = record_meta(path, kind)
    if not meta: return None
    key = hashlib.sha256((kind + ":" + str(path.relative_to(root))).encode()).hexdigest()
    return dict(meta, id=key, modified=stat.st_mtime, size=stat.st_size, _path=path)


def safe_entry(kind, root, path):
    try: return catalog_entry(kind, root, path)
    except (OSError, ValueError, TypeError, AttributeError): return None


def provider_root(provider):
    root = dict(transcript_roots())[provider].resolve()
    return root if root.is_dir() else None


def claude_project_dir(root, cwd):
    # Claude names each project directory after its cwd with non-alphanumerics as "-".
    return root / re.sub(r"[^A-Za-z0-9]", "-", str(Path(cwd).expanduser()))


def with_children(kind, root, parents):
    entries = list(parents)
    for parent in parents:
        path = parent["_path"]
        for child in (path.parent / path.stem / "subagents").glob("*.jsonl"):
            value = safe_entry(kind, root, child)
            if value: entries.append(value)
    return sorted({x["id"]: x for x in entries}.values(), key=lambda x: x["modified"], reverse=True)


def catalog_for_history(record_id, provider, active_thread=None):
    # Locate by opaque digest / exact native id without reparsing unrelated chats.
    if provider != "claude": return transcript_catalog(write_cache=False)
    root = provider_root(provider)
    if not root: return []
    selected = []
    for path in root.rglob("*.jsonl"):
        key = hashlib.sha256((provider + ":" + str(path.relative_to(root))).encode()).hexdigest()
        if key != record_id and (not active_thread or path.stem != active_thread): continue
        value = safe_entry(provider, root, path)
        if value: selected.append(value)
    return with_children(provider, root, selected)


def scoped_records(provider, workspace, limit=12):
    """Root conversations started in this workspace; never parses other projects."""
    root = provider_root(provider)
    if provider != "claude" or not root: return []
    cwd = str(Path(workspace).expanduser())
    directory = claude_project_dir(root, cwd)
    try: files = sorted(directory.glob("*.jsonl"), key=lambda x: x.stat().st_mtime, reverse=True)[:limit * 2]
    except OSError: return []
    records = [x for x in (safe_entry(provider, root, f) for f in files) if x and not x.get("parent")]
    return records[:limit]


def locate_thread(provider, thread, workspace):
    root = provider_root(provider)
    if provider != "claude" or not root or not re.fullmatch(UUID_RE, thread or ""): return None
    preferred = claude_project_dir(root, workspace) / (thread + ".jsonl")
    for path in [preferred, *root.glob("*/" + thread + ".jsonl")]:
        if path.is_file():
            value = safe_entry(provider, root, path)
            if value and not value.get("parent"): return value
    return None


def remote_resolve(items):
    """Remote side: map each ch workspace to its live native session and record."""
    out = {}
    for item in items[:32]:
        workspace, provider = item.get("workspace"), item.get("provider", "claude")
        if not isinstance(workspace, str) or provider not in ("claude", "codex"): continue
        active = remote_active_history(workspace, provider)
        record = locate_thread(provider, active.get("thread"), workspace) if active.get("status") == "matched" else None
        out[workspace] = {"active": active, "record": public_record(record) if record else None,
                          "candidates": [] if record else [public_record(x) for x in scoped_records(provider, workspace)]}
    return out


def remote_history_page(request, catalog=None):
    active=remote_active_history(request["workspace"],request.get("provider","claude"))
    if catalog is None: catalog=catalog_for_history(request["record_id"],request.get("provider","claude"),active.get("thread"))
    matches=[x for x in catalog if x["provider"]==request.get("provider","claude") and x["thread"]==active.get("thread") and not x.get("parent")]
    current=matches[0] if active.get("status")=="matched" and matches else None
    follow=request.get("follow_active",False)
    if not isinstance(follow,bool): raise BridgeError("Invalid follow_active")
    selected=dict(request)
    if follow and "before" not in request and current: selected["record_id"]=current["id"]
    result=attach_kids(history_page(selected,catalog),catalog,selected)
    result["active_status"]=active
    if current: result["active_record"]=public_record(current)
    result["active_changed"]=selected["record_id"]!=request["record_id"]
    return result

# ─── Remote reads over a ch route ────────────────────────────────────────────
# A ch pane's history lives on the other computer. Measured on a 275 ms link, a fresh SSH
# login costs ~4 s and shipping the ~100 KB adapter another ~1 s, while the remote work
# itself takes ~10 ms. So reads (1) reuse one SSH connection through the bridge's OWN control
# socket (never the user's) for up to REMOTE_PERSIST idle seconds (an open chat polls far more
# often), and (2) run a content-addressed copy of the adapter kept in the remote user's
# ~/.herdr-pocket/bridge/, checked against its SHA-256 before every run. When that copy is
# missing or different, the adapter is shipped on stdin once and stored. Requests travel on
# stdin, never in the command.
REMOTE_PERSIST = 300
REMOTE_HELPER_KEEP = 3
REMOTE_HELPER_LIMIT = 4_000_000
# The only remote command for reads. argv[1] is the adapter's hex SHA-256; stdin is "<n>\n",
# then n adapter bytes (n=0: use the stored copy), then one JSON request line. It executes
# nothing whose hash differs from argv[1].
REMOTE_LOADER = (
    'import sys,os,stat,json,hashlib\n'
    'h=sys.argv[1];b=sys.stdin.buffer;n=int(b.readline());s=b.read(n) if n else b""\n'
    'p=os.path.join(os.path.expanduser("~"),".herdr-pocket","bridge",h+".py")\n'
    'if not n and len(h)==64 and not h.strip("0123456789abcdef"):\n'
    ' try:\n'
    '  with open(os.open(p,os.O_RDONLY|os.O_NOFOLLOW),"rb") as r:\n'
    '   t=os.fstat(r.fileno())\n'
    '   if stat.S_ISREG(t.st_mode) and t.st_uid==os.getuid() and not t.st_mode&0o022: s=r.read(%d)\n'
    ' except OSError: pass\n'
    'if hashlib.sha256(s).hexdigest()!=h:\n'
    ' print(json.dumps({"helper_missing":True}));sys.exit()\n'
    'exec(compile(s,p,"exec"),{"__name__":"herdr_pocket_remote","HELPER_INSTALL":(p,s) if n else None})\n'
) % REMOTE_HELPER_LIMIT
REMOTE_COMMAND = "python3 -I -c '" + REMOTE_LOADER + "'"
_remote_program = None


def remote_program():
    """The adapter that runs on the other computer: this file's functions plus remote_main()."""
    global _remote_program
    if _remote_program is None:
        source = Path(__file__).read_text().rsplit('\nif __name__ == "__main__":', 1)[0]
        program = (source + "\nremote_main()\n").encode()
        _remote_program = (program, hashlib.sha256(program).hexdigest())
    return _remote_program


def route_ssh_options(route):
    """The route's own ssh options minus -S: a control socket is only ever the bridge's own."""
    options, out = list(route["ssh"]), []
    while options:
        arg = options.pop(0)
        if arg == "-S" and len(options) > 1: options.pop(0); continue
        out.append(arg)
    return out


def ssh_control_dir():
    """~/.herdr-pocket/ssh (0700, owned by us, no symlinks), or None to connect without reuse."""
    base = Path.home() / ".herdr-pocket"; folder = base / "ssh"
    try:
        for path in (base, folder):
            try: path.mkdir(mode=0o700)
            except FileExistsError: pass
            info = path.lstat()
            if not stat_module.S_ISDIR(info.st_mode) or info.st_uid != os.getuid(): return None
        if folder.lstat().st_mode & 0o077: os.chmod(folder, 0o700)
    except OSError: return None
    # A unix socket path is limited to ~104 bytes; ssh adds a 17-byte suffix while binding.
    return folder if len(str(folder)) + 44 + 18 <= 104 else None


def remote_ssh_args(route, reuse=True):
    folder = ssh_control_dir() if reuse else None
    control = ["-o", "ControlMaster=auto", "-o", "ControlPath=" + str(folder) + "/cm-%C", "-o", "ControlPersist=%d" % REMOTE_PERSIST] \
        if folder else ["-o", "ControlMaster=no", "-o", "ControlPath=none"]
    return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes",
            "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", *control, *route_ssh_options(route)]


def remote_ssh_reset(route):
    """Ends our shared connection for this route (e.g. after a timeout) so the next read starts fresh."""
    folder = ssh_control_dir()
    if not folder: return
    try: subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=" + str(folder) + "/cm-%C", "-O", "exit", *route_ssh_options(route)],
                        capture_output=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired): pass


def remote_exec(route, payload, digest, deadline, reuse=True):
    remaining = deadline - time.monotonic()
    if remaining <= 0: raise BridgeError("远端历史读取达到本次时限，请刷新重试")
    try: return subprocess.run([*remote_ssh_args(route, reuse), REMOTE_COMMAND + " " + digest], input=payload, capture_output=True, timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        # A wedged shared connection must not stall the next read as well.
        if reuse: remote_ssh_reset(route)
        raise BridgeError("远端电脑响应超时") from exc
    except OSError as exc: raise BridgeError("无法启动 SSH 连接远端电脑") from exc


def remote_read(route, request, limit=None):
    # Reads only: the remote entry points read the two authorized history roots. No provider
    # credentials, shell input or process environment; see SECURITY.md.
    limit = limit or (25 if request["op"] == "history" else 15)
    deadline = time.monotonic() + (limit if _remote_deadline is None else min(limit, _remote_deadline - time.monotonic()))
    program, digest = remote_program()
    line = json.dumps(request).encode() + b"\n"
    reuse = True
    result = remote_exec(route, b"0\n" + line, digest, deadline)
    if result.returncode == 255 and deadline - time.monotonic() > 4:
        # ssh itself failed (stale shared socket, session limit…). Reads are safe to repeat once
        # over a fresh, unshared connection.
        remote_ssh_reset(route); reuse = False
        result = remote_exec(route, b"0\n" + line, digest, deadline, reuse)
    if not result.returncode and result.stdout.startswith(b'{"helper_missing"'):
        result = remote_exec(route, str(len(program)).encode() + b"\n" + program + line, digest, deadline, reuse)
    if result.returncode: raise BridgeError("连不上远端电脑：SSH 认证、网络或 Python 环境不可用")
    if len(result.stdout) > 2_000_000: raise BridgeError("远端历史响应过大")
    try: data = json.loads(result.stdout)
    except ValueError as exc: raise BridgeError("远端历史返回格式异常") from exc
    if not isinstance(data, dict) or data.get("helper_missing"): raise BridgeError("远端历史返回格式异常")
    if data.get("error"):
        # The remote adapter's own message (e.g. "历史记录已不存在") is safer to show than a guess.
        raise BridgeError(str(data["error"])[:200] if isinstance(data["error"], str) and "exceeds" not in data["error"] else "远端历史读取失败或响应超过 2 MB")
    return data


def remote_dispatch(request):
    """Runs on the other computer: the allowed read entry points only."""
    op = request.get("op")
    if op == "resolve": return {"routes": remote_resolve(request.get("items", []))}
    if op == "history": return remote_history_page(request)
    if op == "image":
        try: return remote_transcript_image(request)
        except BridgeError as exc: return {"image_error": str(exc)[:200]}
    if op == "catalog": return {"records": [public_record(x) for x in scoped_records(request.get("provider", "claude"), request["workspace"], 100)]}
    if op == "kids": return remote_kids_main(request.get("items"))
    if op == "fileView": return view_file(request.get("path"), request.get("cwd"), view_roots(request.get("record_id"), request.get("provider", "claude"), request.get("workspace")))
    return {"error": "unknown remote op"}


def remote_install_helper(path, data):
    """Runs on the other computer: store the verified adapter as ~/.herdr-pocket/bridge/<sha256>.py
    (folders 0700, file 0600, no symlinks, atomic) and keep only the newest few versions."""
    folder = Path(path).parent
    for part in (folder.parent, folder):
        try: part.mkdir(mode=0o700)
        except FileExistsError: pass
        info = part.lstat()
        if not stat_module.S_ISDIR(info.st_mode) or info.st_uid != os.getuid(): return
    temp = folder / ("." + os.urandom(8).hex() + ".part")
    try:
        with open(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600), "wb") as out: out.write(data)
        os.replace(temp, path)
    finally:
        try: temp.unlink()
        except FileNotFoundError: pass
    helpers = sorted((p for p in folder.iterdir() if re.fullmatch(r"[a-f0-9]{64}\.py", p.name) and p.is_file() and not p.is_symlink()),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    for old in helpers[REMOTE_HELPER_KEEP:]:
        if old.name != Path(path).name: old.unlink()


def remote_main():
    """Runs on the other computer under REMOTE_LOADER: one JSON request on stdin, one JSON line out."""
    os.umask(0o077)
    install = globals().get("HELPER_INSTALL")
    if install:
        try: remote_install_helper(*install)
        except OSError: pass
    try: result = remote_dispatch(json.loads(sys.stdin.buffer.readline(LIMIT + 1)))
    except (BridgeError, ValueError, KeyError, TypeError) as exc: result = {"error": str(exc)[:200]}
    encoded = json.dumps(result, ensure_ascii=False)
    print(encoded if len(encoded.encode()) <= 2_000_000 else '{"error":"history response exceeds 2 MB"}', flush=True)


def prefetch_remote(pairs):
    """One SSH round trip per remote account, all accounts in parallel."""
    from concurrent.futures import ThreadPoolExecutor
    groups = {}
    for route, provider in pairs:
        key = json.dumps(route["ssh"])
        group = groups.setdefault(key, {"route": route, "items": {}})
        group["items"][route["workspace"]] = provider
    def run(group):
        items = [{"workspace": w, "provider": p} for w, p in group["items"].items()]
        try: return remote_read(group["route"], {"op": "resolve", "items": items}).get("routes", {})
        except BridgeError as exc: return exc
    with ThreadPoolExecutor(max_workers=max(1, min(8, len(groups)))) as pool:
        for key, value in zip(groups, pool.map(run, groups.values())):
            _remote_results[key] = value


def remote_resolution(route, context):
    key = json.dumps(route["ssh"])
    if key not in _remote_results: prefetch_remote([(route, context["provider"])])
    data = _remote_results.get(key)
    if isinstance(data, BridgeError): return {"status": "remote_error", "reason": str(data), "remote": context}
    item = (data or {}).get(route["workspace"])
    if not item: return {"status": "remote_error", "reason": "远端没有返回这个窗格的结果", "remote": context}
    active = item.get("active") or {}
    if item.get("record"):
        record = wrap_remote_record(item["record"], route, context)
        return {"status": "matched", "source": "native-process", "record_id": record["id"], "thread": record["thread"], "record": record, "remote": context}
    candidates = [wrap_remote_record(x, route, context) for x in item.get("candidates", [])]
    if active.get("status") == "matched":
        return {"status": "pending", "thread": active.get("thread"), "remote": context, "candidates": candidates,
                "reason": "远端会话刚开始，历史文件还没写出"}
    return {"status": "remote_candidates" if candidates else "remote_missing", "remote": context, "candidates": candidates,
            "reason": active.get("reason") or "远端会话没有公开可核实的会话标识"}


def wrap_remote_record(record, route, context):
    return dict(record, id="remote:"+route["key"]+":"+record["id"], remote=context)


def remote_catalog(route, context):
    data = remote_read(route, {"op": "catalog", "workspace": route["workspace"], "provider": context.get("provider", "claude")})
    return [wrap_remote_record(x, route, context) for x in data.get("records", [])]


def route_for_context(context, memo=None):
    if not isinstance(context,dict): raise BridgeError("Invalid remote history context")
    # memo: one Herdr session check and agent list for many panes of one request.
    if memo is None: memo = {}
    name = json.dumps(context.get("session"))
    if name not in memo:
        prefix = select_session(context); memo[name] = (prefix, agents(prefix))
    prefix, found = memo[name]
    agent = next((a for a in found if a.get("pane_id")==context.get("target") and a["identity"]==context.get("identity")),None)
    if not agent: raise BridgeError("远端窗格已改变，请刷新会话列表")
    info = call(prefix+["pane","process-info","--pane",agent["pane_id"]]).get("process_info",{})
    route=route_from_process_info(info)
    if route: return route
    raise BridgeError("远端 SSH 路由已断开，请刷新会话列表")


def route_from_process_info(info):
    queue = [(p.get("pid"),p.get("argv",[])) for p in info.get("foreground_processes",[])]; seen=set()
    while queue and len(seen)<64:
        pid, initial = queue.pop(0)
        if not isinstance(pid,int) or pid in seen: continue
        seen.add(pid); snapshot=process_snapshot(pid); argv=snapshot["argv"] if snapshot else initial
        route=ch_ssh_route(argv)
        if route: return route
        if snapshot: queue.extend((child,[]) for child in snapshot["children"])
    return None


def remote_history_request(request):
    global _remote_deadline
    _remote_deadline = None
    context=request["remote"]; route=route_for_context(context)
    if request["op"]=="catalog":
        records=remote_catalog(route,context)
        query=request.get("query",""); thread=request.get("thread")
        if not isinstance(query,str) or len(query)>200: raise BridgeError("Invalid search")
        if query: records=[x for x in records if query.lower() in (x["title"]+" "+x["thread"]).lower()]
        if thread: records=[x for x in records if x["thread"]==thread]
        offset=request.get("offset",0)
        if not isinstance(offset,int) or isinstance(offset,bool) or offset<0: raise BridgeError("Invalid catalog offset")
        return {"records":records[offset:offset+100],"total":len(records),"next":offset+100 if len(records)>offset+100 else None}
    key=request.get("record_id",""); prefix="remote:"+route["key"]+":"
    if not isinstance(key,str) or not key.startswith(prefix) or not re.fullmatch(r"[a-f0-9]{64}",key[len(prefix):]): raise BridgeError("Invalid remote history record")
    data={"op":"history","record_id":key[len(prefix):],"workspace":route["workspace"],"provider":context.get("provider","claude"),"follow_active":request.get("follow_active",False)}
    if "before" in request: data["before"]=request["before"]
    result=remote_read(route,data)
    result["record"]=wrap_remote_record(result["record"],route,context)
    if result.get("active_record"): result["active_record"]=wrap_remote_record(result["active_record"],route,context)
    result["children"]=[wrap_remote_record(x,route,context) for x in result["children"]]
    if isinstance(result.get("kids"),dict) and isinstance(result["kids"].get("items"),list):
        result["kids"]["items"]=[wrap_remote_record(x,route,context) if x.get("id") else x for x in result["kids"]["items"] if isinstance(x,dict)]
    return result

def text_content(value):
    if isinstance(value, str): return value
    if isinstance(value, list):
        return "\n".join(str(b.get("text", "")) if b.get("type") in ("text", "input_text", "output_text")
                         else "[图片附件]" if b.get("type") in ("image", "input_image") else ""
                         for b in value if isinstance(b, dict)).strip()
    return ""


def record_meta(path, provider):
    meta = {"provider": provider, "thread": path.stem, "parent": None, "cwd": "", "title": "", "role": ""}
    read = 0
    seen_meta = False
    start = 0
    with path.open("rb") as stream:
        for _ in range(96):
            line = stream.readline(2_000_001); read += len(line)
            if len(line) > 2_000_000 or read > 4_000_000: break
            try: row = json.loads(line)
            except (ValueError, UnicodeError): continue
            if not isinstance(row,dict): continue
            # A forked Codex sub-agent copies its parent's history (including the parent's
            # session_meta) before its own work starts; only the first session_meta is ours.
            if provider == "codex" and row.get("type") == "session_meta" and not seen_meta:
                seen_meta = True
                value = row.get("payload", {})
                source = value.get("source", {})
                sub = source.get("subagent", {}) if isinstance(source, dict) else {}
                # Internal guard/review workers are not user conversations.
                if isinstance(sub, dict) and sub.get("other") in ("guardian", "review"):
                    return None
                spawn = sub.get("thread_spawn", {}) if isinstance(sub, dict) else {}
                agent_path = value.get("agent_path") or spawn.get("agent_path") or ""
                meta.update(thread=value.get("id", path.stem), cwd=value.get("cwd", ""),
                            parent=value.get("parent_thread_id") or spawn.get("parent_thread_id"),
                            role=agent_path.rstrip("/").rsplit("/", 1)[-1] or value.get("agent_nickname") or value.get("agent_role") or
                                 (sub.get("other", "") if isinstance(sub, dict) else ""))
                start = value.get("subagent_history_start_ordinal") or 0
                if isinstance(start, int) and start > 0: meta["start"] = start
                continue
            if provider == "codex" and start and isinstance(row.get("ordinal"), int) and row["ordinal"] < start:
                continue
            if provider == "codex" and row.get("type") == "response_item":
                message = row.get("payload", {})
                if message.get("role") == "user" and not meta["title"]:
                    title = text_content(message.get("content", []))
                    if title and not title.startswith(("<", "# AGENTS")):
                        meta["title"] = title[:100]
            # Normal sessions are identified within 32 lines; forks may need to skip a copied prefix.
            if meta["title"] and _ >= 31: break
            if provider == "claude":
                meta["cwd"] = row.get("cwd", meta["cwd"])
                if "subagents" in path.parts:
                    meta["parent"] = path.parent.parent.name
                    meta["thread"] = path.stem.removeprefix("agent-")
                    if not meta["role"]: meta.update(claude_subagent_label(path))
                else: meta["thread"] = row.get("sessionId", path.stem)
                if row.get("type") == "user" and not row.get("isMeta") and not meta["title"]:
                    title = text_content(row.get("message", {}).get("content", ""))
                    if title and not title.startswith(("<", "# AGENTS")): meta["title"] = title[:100]
    if meta.get("label"): meta["title"] = meta.pop("label")
    meta["title"] = meta["title"] or meta["role"] or ("对话 · " + (Path(meta["cwd"]).name or str(meta["thread"])[:8]))
    return meta


def claude_subagent_label(path):
    """Claude writes <agent>.meta.json beside a sub-agent transcript with its short description."""
    side = path.with_name(path.stem + ".meta.json")
    try:
        if side.is_symlink() or side.stat().st_size > 65536: return {"role": "subagent"}
        value = json.loads(side.read_text())
        label = str(value.get("description") or "").strip()[:100]
        return {"role": str(value.get("agentType") or "subagent")[:60], **({"label": label} if label else {})}
    except (OSError, ValueError, AttributeError):
        return {"role": "subagent"}


def transcript_catalog(write_cache=True):
    cache_path = Path.home() / ".local/state/herdr-pocket/catalog-v4.json"
    try: cache = json.loads(cache_path.read_text())
    except (OSError, ValueError): cache = {}
    entries, new_cache = [], {}
    for provider, root in transcript_roots():
        root = root.resolve()
        if not root.is_dir(): continue
        for path in root.rglob("*.jsonl"):
            try:
                if path.is_symlink() or not path.resolve().is_relative_to(root): continue
                stat = path.stat()
                key = hashlib.sha256((provider + ":" + str(path.relative_to(root))).encode()).hexdigest()
                saved = cache.get(key, {}); stamp = [stat.st_mtime_ns, stat.st_size]
                meta = saved.get("meta") if saved.get("stamp") == stamp else record_meta(path, provider)
                if not meta: continue
                new_cache[key] = {"stamp": stamp, "meta": meta}
                entries.append(dict(meta, id=key, modified=stat.st_mtime, size=stat.st_size, _path=path))
            except (OSError, ValueError, TypeError, AttributeError): continue
    try:
        if not write_cache: return sorted(entries, key=lambda x: x["modified"], reverse=True)
        import tempfile
        cache_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=cache_path.parent, delete=False) as stream:
            json.dump(new_cache, stream); temp = stream.name
        os.replace(temp, cache_path)
    except OSError: pass
    return sorted(entries, key=lambda x: x["modified"], reverse=True)


def public_record(value):
    return {k: v for k, v in value.items() if not k.startswith("_")}


def readable_output(value):
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, (dict, list)): return readable_output(parsed)
        except ValueError: pass
        return value
    if isinstance(value, list):
        return "\n".join(readable_output(x) for x in value)
    if isinstance(value, dict):
        for field in ("text", "output", "content", "stdout"):
            if field in value:
                text = readable_output(value[field])
                if value.get("exit_code") is not None: text += "\nExit code: " + str(value["exit_code"])
                return text
        return json.dumps(value, ensure_ascii=False, indent=2)
    return str(value)


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def slash_record_text(content):
    """Claude slash commands in a transcript: `<command-name>/x</command-name>…` and the
    `<local-command-stdout>` that follows. Returned as-is (minus terminal colour codes) so the
    phone can show them as a command card; the caveat and other local rows stay hidden."""
    if not isinstance(content, str): return ""
    text = content.strip()
    if text.startswith(("<command-name>", "<command-message>")) and "<command-name>" in text:
        return ANSI_RE.sub("", text)
    if text.startswith(("<local-command-stdout>", "<local-command-stderr>")):
        return ANSI_RE.sub("", text)
    return ""


def normalize_record(row, provider, offset):
    timestamp = row.get("timestamp", ""); result = []
    def add(kind, text, title="", call_id="", phase=""):
        if not text: return
        item = {"id": str(offset) + ":" + str(len(result)), "kind": kind,
                "text": text.encode("utf-8")[:16000].decode("utf-8", errors="ignore"), "title": title, "call_id": call_id,
                "timestamp": timestamp, "truncated": len(text.encode("utf-8")) > 16000}
        # Codex marks progress notes ("commentary") vs the turn's reply ("final_answer");
        # the UI folds the former and highlights the latter.
        if phase: item["phase"] = phase
        result.append(item)
    if provider == "codex":
        if row.get("type") != "response_item": return []
        value = row.get("payload", {}); kind = value.get("type")
        if kind == "message" and value.get("role") in ("user", "assistant"):
            if value.get("channel") not in ("analysis", "summary"):
                content = value.get("content", [])
                pictures = [i for i, b in enumerate(content) if embedded_image(b)] if isinstance(content, list) and value.get("role") == "user" else []
                if pictures:
                    # Codex wraps each pasted picture in <image name=…> … </image> text blocks.
                    content = [b for i, b in enumerate(content) if i not in pictures and not (
                        isinstance(b, dict) and re.fullmatch(r"\s*(<image\b[^>]*>|</image>)\s*", str(b.get("text", ""))))]
                text = text_content(content)
                # Codex appends machine-readable memory citations to replies; they are not for people.
                if value.get("role") == "assistant": text = re.sub(r"\s*<oai-mem-citation>.*?</oai-mem-citation>\s*", "\n", text, flags=re.S).strip()
                if value.get("role") != "user" or not text.startswith(("# AGENTS.md", "<environment_context>", "<INSTRUCTIONS>")):
                    add(value["role"], text, phase=value.get("phase") if isinstance(value.get("phase"), str) else "")
                    if pictures: attach_images(result, "user", pictures, add)
        elif kind == "agent_message":
            # Inter-agent message (sub-Agent → parent). Only the visible header/payload is shown;
            # encrypted content stays hidden.
            text = text_content(value.get("content", [])); header, _, payload = text.partition("Payload:")
            fields = dict(line.split(": ", 1) for line in header.splitlines() if ": " in line)
            sender = str(value.get("author") or fields.get("Sender") or "子 Agent")
            add("agent", payload.strip() or "（内容只对 Agent 可见）", sender, "",
                fields.get("Message Type", "").strip().lower())
        elif kind in ("function_call", "custom_tool_call"):
            args = value.get("arguments", value.get("input", ""))
            if not isinstance(args, str): args = json.dumps(args, ensure_ascii=False, indent=2)
            try:
                parsed = json.loads(args)
                args = parsed.get("cmd", parsed.get("command")) or json.dumps(parsed, ensure_ascii=False, indent=2)
            except (ValueError, AttributeError): pass
            add("tool", args, value.get("name", "工具调用"), value.get("call_id", ""))
        elif kind in ("function_call_output", "custom_tool_call_output"):
            output = value.get("output", "")
            output = readable_output(output)
            add("result", output, "执行结果", value.get("call_id", ""))
    else:
        if row.get("type") == "system" and row.get("subtype") == "local_command" and not row.get("isMeta"):
            # Newer Claude Code logs slash commands and their printed result as system rows.
            text = slash_record_text(row.get("content"))
            if text: add("user", text)
            return result
        if row.get("type") not in ("user", "assistant") or row.get("isMeta"): return []
        value = row.get("message", {}); content = value.get("content", "")
        if isinstance(content, str):
            command = slash_record_text(content)
            if command: add("user", command)
            elif not content.startswith(("<local-command", "<command-name", "<command-message", "<system-reminder")): add(row["type"], content)
        elif isinstance(content, list):
            pictures = [i for i, b in enumerate(content) if embedded_image(b)]
            for block in content:
                if not isinstance(block, dict): continue
                if block.get("type") == "text": add(row["type"], block.get("text", ""))
                elif block.get("type") == "tool_use":
                    args = block.get("input", {}); text = args.get("command") if isinstance(args, dict) else None
                    add("tool", text or json.dumps(args, ensure_ascii=False, indent=2), block.get("name", "工具调用"), block.get("id", ""))
                elif block.get("type") == "tool_result":
                    add("result", text_content(block.get("content", "")), "执行失败" if block.get("is_error") else "执行结果", block.get("tool_use_id", ""))
                elif block.get("type") == "image" and not embedded_image(block): add(row["type"], "[图片附件 · 请在电脑查看]")
            if pictures: attach_images(result, row["type"], pictures, add)
    return result


def attach_images(result, kind, blocks, add):
    """Embedded pictures ride on the row's text message (or an empty one); the phone loads them lazily."""
    images = [{"block": i} for i in blocks[:8]]
    owner = next((x for x in reversed(result) if x["kind"] == kind), None)
    if owner is None:
        add(kind, " ")
        owner = result[-1]; owner["text"] = ""
    owner["images"] = images


def history_page(request, catalog):
    entry = next((x for x in catalog if x["id"] == request.get("record_id")), None)
    if not entry: raise BridgeError("历史记录已不存在，请刷新列表")
    size = entry["_path"].stat().st_size; cursor = request.get("before", size)
    if not isinstance(cursor, int) or isinstance(cursor, bool) or not 0 <= cursor <= size:
        raise BridgeError("Invalid history cursor")
    messages, partial, before = [], False, cursor
    scanned = 0
    # Skip sparse/internal tails automatically, while bounding total I/O. A page
    # cursor stays at a complete line boundary so normal cross-window rows survive.
    with entry["_path"].open("rb") as stream:
        while before > 0 and len(messages) < 35 and scanned < 16_000_000:
            end = before; window_start = max(0, end - 2_000_000)
            stream.seek(window_start)
            if window_start:
                stream.seek(window_start - 1)
                if stream.read(1) != b"\n": stream.readline(end - window_start)
            start = min(stream.tell(), end)
            data = stream.read(end - start)
            scanned += end - window_start
            lines, pos = [], start
            for line in data.splitlines(keepends=True):
                if line.endswith(b"\n"): lines.append((pos, line))
                else: partial = True
                pos += len(line)
            # If one record exceeds the whole window, advance across that record.
            before = start if start < end else window_start
            for offset, line in reversed(lines):
                try:
                    row = json.loads(line)
                    copied = entry.get("start") and isinstance(row.get("ordinal"), int) and row["ordinal"] < entry["start"]
                    values = [] if copied else normalize_record(row, entry["provider"], offset)
                except (ValueError, TypeError, AttributeError): values = []
                messages[0:0] = values; before = offset
                if len(messages) >= 35: break
    return {"record": public_record(entry), "messages": messages, "before": before,
            "has_more": before > 0, "partial": partial, "bounded": before > 0 and len(messages)<35,
            "children": [public_record(x) for x in catalog if x["parent"] == entry["thread"] and x["provider"] == entry["provider"]]}


# ─── Glance: one-line previews for the session list ─────────────────────────
# The list shows what each agent is doing without opening it. The phone already
# knows each local agent's record (id + native thread); this reads only the tail
# of that transcript, never the whole file, and skips files that did not change.
GLANCE_ITEMS = 40
GLANCE_WINDOWS = (262_144, 1_048_576)  # bytes from the end; the larger one only when the tail had no reply
GLANCE_TEXT = 160
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"}


def glance_line(text, limit=GLANCE_TEXT):
    """First readable line of a message, without Markdown punctuation."""
    fence = False
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if line.startswith("```"):
            fence = not fence; continue
        if fence or not line or re.fullmatch(r"[-*_=|:\s]{3,}", line): continue
        line = re.sub(r"^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d{1,3}[.)]\s+)", "", line)
        line = re.sub(r"\*\*|__|`|~~", "", line)
        line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"\s+", " ", line).strip()
        if line: return line[:limit]
    return ""


PATCH_FILE_RE = re.compile(r"\*\*\* (?:Update|Add|Delete) File: ([^\n\\\"]+)")
CODE_TOOL_RE = re.compile(r"tools\.(\w{1,60})\(")


def code_tool(text):
    """Newer Codex runs tools from a small script (`exec`): find the first tools.<name>({…}) call."""
    found = CODE_TOOL_RE.search(str(text))
    if not found: return None, {}
    name, raw = found.group(1), str(text)[found.end():found.end() + 8000]
    args = {}
    command = re.search(r"^\s*\{\s*\"?(?:cmd|command)\"?\s*:\s*(\"(?:[^\"\\]|\\.)*\")", raw)
    if command:
        try: args["cmd"] = json.loads(command.group(1))
        except ValueError: pass
    for field in ("query", "message", "path", "file_path", "question"):
        value = re.search(r"^\s*[\[{][^}]{0,400}?\b" + field + r"\"?\s*:\s*(\"(?:[^\"\\]|\\.)*\")", raw)
        if value:
            try: args[field] = json.loads(value.group(1))
            except ValueError: pass
    return name, args


def glance_tool(title, text):
    """A tool call as {verb, text}: what it does and its target, short."""
    name = str(title or "")
    if name == "exec":
        inner, inner_args = code_tool(text)
        if inner == "apply_patch": return {"verb": "edit", "text": ", ".join(Path(f.strip()).name for f in PATCH_FILE_RE.findall(str(text))[:3])}
        if inner: return glance_tool(inner, json.dumps(inner_args, ensure_ascii=False))
        return {"verb": "run", "text": ""}
    args = None
    if isinstance(text, str) and text.lstrip().startswith("{"):
        try: args = json.loads(text)
        except ValueError: args = None
    if not isinstance(args, dict): args = {}
    def base(value): return Path(str(value)).name if value else ""
    if name in ("Bash", "exec_command", "shell", "local_shell", "container.exec", "shell_command", "BashOutput"):
        command = args.get("command") or args.get("cmd") or text
        if isinstance(command, list): command = " ".join(str(x) for x in command)
        return {"verb": "run", "text": glance_line(command, 120)}
    if name == "apply_patch":
        return {"verb": "edit", "text": ", ".join(base(f.strip()) for f in PATCH_FILE_RE.findall(str(text))[:3])}
    if name in EDIT_TOOLS: return {"verb": "edit", "text": base(args.get("file_path") or args.get("notebook_path"))}
    if name in ("Read", "NotebookRead"): return {"verb": "read", "text": base(args.get("file_path"))}
    if name in ("Grep", "Glob", "LS"): return {"verb": "search", "text": glance_line(args.get("pattern") or args.get("path") or "", 80)}
    if name in ("WebFetch", "WebSearch", "web_search"): return {"verb": "web", "text": glance_line(args.get("query") or args.get("url") or "", 80)}
    if name in ("Task", "Agent", "spawn_agent", "spawn_agents"): return {"verb": "agent", "text": glance_line(args.get("description") or args.get("prompt") or args.get("message") or "", 80)}
    if name in ("TodoWrite", "update_plan"): return {"verb": "plan", "text": ""}
    if name in ("sleep", "wait", "TaskOutput", "write_stdin"): return {"verb": "wait", "text": ""}
    if name in ("send_message", "followup_task"): return {"verb": "agent", "text": glance_line(args.get("message") or "", 80)}
    if name in ("AskUserQuestion", "request_user_input", "request_user_input_async"):
        questions = args.get("questions") if isinstance(args.get("questions"), list) else []
        first = questions[0] if questions and isinstance(questions[0], dict) else {}
        return {"verb": "ask", "text": glance_line(first.get("question") or first.get("title") or first.get("header") or args.get("question") or "", 140)}
    return {"verb": "tool", "text": glance_line(name, 60)}


def glance_edits(item, files):
    if item["title"] in ("apply_patch", "exec"):
        files.update(f.strip() for f in PATCH_FILE_RE.findall(item["text"])); return
    if item["title"] not in EDIT_TOOLS: return
    try: args = json.loads(item["text"])
    except ValueError: return
    if isinstance(args, dict) and (args.get("file_path") or args.get("notebook_path")):
        files.add(str(args.get("file_path") or args.get("notebook_path")))


def glance_tail(path, provider, window, modes=None):
    """Normalized messages from the last `window` bytes, complete lines only. With `modes`, the
    newest mode settings the transcript recorded in that window are collected into it."""
    size = path.stat().st_size
    with path.open("rb") as stream:
        start = max(0, size - window)
        stream.seek(start)
        if start: stream.readline()
        data = stream.read(window)
    items = []
    for line in data.splitlines():
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                items.extend(normalize_record(row, provider, 0))
                if modes is not None: transcript_modes(row, provider, modes)
        except (ValueError, TypeError, AttributeError): continue
    return items, start == 0


def glance_summary(items):
    """What the newest turn looks like: the task, the reply, current activity, pending tool."""
    turn = len(items)
    for i in range(len(items) - 1, -1, -1):
        if items[i]["kind"] == "user" and (items[i]["text"].strip() or items[i].get("images")):
            turn = i; break
    result = {}
    if turn < len(items):
        # Slash commands are logged as <command-name>/x</command-name>…; keep just the words.
        task = re.sub(r"<[^>]{1,40}>", " ", items[turn]["text"]) if items[turn]["text"].startswith("<") else items[turn]["text"]
        result["task"] = {"text": glance_line(task, 120) or ("[图片]" if items[turn].get("images") else ""), "at": items[turn].get("timestamp") or ""}
    after = items[turn + 1:] if turn < len(items) else items
    reply = None
    for x in reversed(items):
        if x["kind"] == "assistant" and x.get("phase") != "commentary" and glance_line(x["text"]):
            reply = x; break
    if reply: result["reply"] = {"text": glance_line(reply["text"]), "at": reply.get("timestamp") or "",
                                 "current": any(x is reply for x in after)}
    answered = {x["call_id"] for x in after if x["kind"] == "result" and x.get("call_id")}
    activity, files, tools, failed = None, set(), 0, 0
    for x in after:
        if x["kind"] == "tool":
            tools += 1; glance_edits(x, files)
            activity = dict(glance_tool(x["title"], x["text"]), kind="tool", at=x.get("timestamp") or "",
                            open=bool(x.get("call_id")) and x["call_id"] not in answered)
        elif x["kind"] == "result" and x.get("title") == "执行失败": failed += 1
        elif x["kind"] == "assistant" and glance_line(x["text"]):
            activity = {"kind": "note", "text": glance_line(x["text"]), "at": x.get("timestamp") or "", "open": False}
        elif x["kind"] == "agent" and glance_line(x["text"]):
            activity = {"kind": "agent", "text": glance_line(x["text"]), "title": glance_line(x["title"], 40), "at": x.get("timestamp") or "", "open": False}
    if activity: result["activity"] = activity
    result["turn"] = {"tools": tools, "files": len(files), "failed": failed}
    stamps = [x.get("timestamp") for x in items if x.get("timestamp")]
    if stamps: result["at"] = stamps[-1]
    return result


def glance_path(item):
    """The transcript an item names: under the provider root, matching both record id and thread."""
    provider, thread, record_id = item.get("provider"), item.get("thread"), item.get("record_id")
    if provider not in ("claude", "codex") or not isinstance(thread, str) or not re.fullmatch(UUID_RE, thread):
        return None
    if not isinstance(record_id, str) or not re.fullmatch(r"[0-9a-f]{64}", record_id): return None
    root = provider_root(provider)
    if not root: return None
    if provider == "claude":
        cwd = item.get("cwd") if isinstance(item.get("cwd"), str) else ""
        paths = ([claude_project_dir(root, cwd) / (thread + ".jsonl")] if cwd else []) + list(root.glob("*/" + thread + ".jsonl"))
    else:
        paths = list(root.glob("*/*/*/rollout-*" + thread + ".jsonl"))
    for path in paths:
        try:
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root): continue
            key = hashlib.sha256((provider + ":" + str(path.relative_to(root))).encode()).hexdigest()
            if key == record_id: return path
        except (OSError, ValueError): continue
    return None


def glance(request):
    items = request.get("items")
    if not isinstance(items, list) or len(items) > GLANCE_ITEMS: raise BridgeError("Invalid glance items")
    out, far = {}, []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("key"), str) or len(item["key"]) > 200: continue
        key = item["key"]
        # A ch pane's transcript is on the other computer: only its sub-agents are read there.
        if isinstance(item.get("remote"), dict):
            if item.get("kids"): far.append(item)
            continue
        try:
            path = glance_path(item)
            if not path: out[key] = {"missing": True}; continue
            stat = path.stat(); stamp = "%d:%d" % (stat.st_mtime_ns, stat.st_size)
            # The background watcher asks about sub-agents only ("preview": false).
            if item.get("preview") is False: out[key] = {"kids_only": True}
            elif item.get("stamp") == stamp: out[key] = {"same": True, "stamp": stamp}
            else:
                for window in GLANCE_WINDOWS:
                    modes = {}
                    messages, whole = glance_tail(path, item["provider"], window, modes)
                    summary = glance_summary(messages)
                    if summary.get("reply") or whole: break
                if item["provider"] == "codex":
                    goal = codex_goal(item["thread"])
                    if goal: modes["goal"] = goal
                if modes: summary["modes"] = dict(modes, source="transcript")
                summary.update(stamp=stamp, modified=stat.st_mtime)
                out[key] = summary
            # Sub-agents change without the parent transcript changing, so they come every time.
            if item.get("kids"): out[key]["kids"] = kids_report(path, item["provider"], item["thread"])
        except OSError:
            out[key] = {"missing": True}
    try:
        if far: out.update({k: dict(v, kids_only=True) for k, v in remote_kids(far).items()})
    finally: kids_save()
    return {"previews": out}


# ─── Sub-agents ("kids"): who is still running under a parent ───────────────
# Herdr reports the parent pane only: a Claude that launched background agents, or a Codex
# waiting on spawned ones, reads "idle"/"done" while its sub-agents still work. This answers,
# read-only and from files alone, which sub-agents a transcript has and which still run.
#   Claude: an Agent/Task tool_use opens a sub-agent; a plain tool_result closes it, an
#     "Async agent launched" result keeps it open until a <task-notification> naming its
#     task-id / tool-use-id arrives (queued or delivered). SendMessage to its id reopens it.
#     Each sub-agent writes <session>/subagents/agent-<id>.jsonl (+ .meta.json with toolUseId).
#   Codex: spawn_agent / followup_task open a task name; an agent_message from that task with
#     "Message Type: FINAL_ANSWER" closes it. Each sub-agent is a forked rollout whose
#     session_meta names the parent thread; task_started / task_complete mark its turns.
# The child's own tail decides first (finished turn = not running); a child written in the last
# KIDS_ACTIVE seconds runs; otherwise the parent's open/closed record decides, bounded in time so
# a crashed run never shows as running forever. Parents are scanned incrementally (byte offset
# kept in a small state file), children by stat + a short tail, so a poll costs milliseconds.
KIDS_ACTIVE = 90
KIDS_QUIET = 1800          # child stopped mid-turn and the parent said nothing: believe it this long
KIDS_OPEN = 6 * 3600       # parent still waits for it (e.g. a long command in the child)
KIDS_STARTING = 600        # launched, no transcript yet
KIDS_LIST = 12
KIDS_TAIL = 65_536
KIDS_SCAN = 32_000_000     # parent bytes read per call; a longer backlog continues next call
KIDS_EVENTS = 400
KIDS_PARENTS = 64
KIDS_HEADS = 4000
KIDS_DAYS = 10
# Cheap byte filters: only lines that can matter are JSON-parsed (Claude writes compact JSON).
CLAUDE_KID_MARKS = re.compile(rb'"name":\s*"(?:Agent|Task|SendMessage)"|<task-notification>')
CODEX_KID_MARKS = re.compile(rb"spawn_agent|followup_task|FINAL_ANSWER")
CLAUDE_TURN_MARK = re.compile(rb'"type":\s*"(?:user|assistant)"')
NOTE_RE = re.compile(r"<task-notification>\s*<task-id>([\w.-]{1,80})</task-id>\s*(?:<tool-use-id>([\w.-]{1,120})</tool-use-id>)?")
TOOL_RESULT_ID_RE = re.compile(rb'"tool_use_id":\s*"([\w.-]{1,120})"')
CODE_SPAWN_RE = re.compile(r"tools\.(spawn_agent|followup_task)\(\s*\{[^}]{0,600}?\b(?:task_name|target)\"?\s*:\s*\"([^\"]{1,200})\"")
_kids_state = None


def kids_state_path():
    return Path.home() / ".local/state/herdr-pocket/kids-v1.json"


def kids_state():
    global _kids_state
    if _kids_state is None:
        try: value = json.loads(kids_state_path().read_text())
        except (OSError, ValueError): value = None
        if not isinstance(value, dict): value = {}
        for part in ("parents", "heads", "meta"):
            if not isinstance(value.get(part), dict): value[part] = {}
        _kids_state = dict(value, dirty=False)
    return _kids_state


def kids_save():
    state = _kids_state
    if not state or not state.get("dirty"): return
    parents = state["parents"]
    for key in sorted(parents, key=lambda k: parents[k].get("used", 0))[:max(0, len(parents) - KIDS_PARENTS)]: del parents[key]
    for part, limit in (("heads", KIDS_HEADS), ("meta", 600)):
        extra = len(state[part]) - limit
        for key in list(state[part])[:max(0, extra)]: del state[part][key]
    path = kids_state_path()
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temp = path.with_name("." + os.urandom(6).hex() + ".part")
        with open(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as out:
            json.dump({k: state[k] for k in ("parents", "heads", "meta")}, out)
        os.replace(temp, path)
        state["dirty"] = False
    except OSError:
        try: temp.unlink()
        except (OSError, UnboundLocalError): pass


def iso_epoch(value):
    if not isinstance(value, str) or not value: return 0.0
    try:
        from datetime import datetime
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError: return 0.0


def kid_event(events, key, state, at, **extra):
    old = events.pop(key, None) or {}
    events[key] = dict(old, s=state, at=at, **{k: v for k, v in extra.items() if v})
    if len(events) > KIDS_EVENTS:
        for k in [k for k in events if events[k]["s"] == "closed"][:len(events) - KIDS_EVENTS] or list(events)[:len(events) - KIDS_EVENTS]:
            del events[k]


def claude_kid_row(row, events):
    at = iso_epoch(row.get("timestamp"))
    kind = row.get("type")
    note = None
    if kind == "queue-operation" and row.get("operation") == "enqueue": note = row.get("content")
    elif kind == "attachment" and isinstance(row.get("attachment"), dict) and row["attachment"].get("type") == "queued_command": note = row["attachment"].get("prompt")
    elif kind == "user":
        content = (row.get("message") or {}).get("content")
        if isinstance(content, str) and content.lstrip().startswith("<task-notification>"): note = content
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict): continue
                if block.get("type") == "text" and str(block.get("text", "")).lstrip().startswith("<task-notification>"): note = block["text"]
                if block.get("type") != "tool_result" or block.get("tool_use_id") not in events: continue
                use = block["tool_use_id"]
                if events[use].get("kind") == "message": continue
                meta = row.get("toolUseResult") if isinstance(row.get("toolUseResult"), dict) else {}
                text = text_content(block.get("content", "")) if not isinstance(block.get("content"), str) else block["content"]
                launched = meta.get("isAsync") is True or meta.get("status") == "async_launched" or text.startswith("Async agent launched")
                agent = meta.get("agentId") or (re.search(r"agentId: ([\w-]{1,80})", text) or [None, None])[1]
                if launched and not block.get("is_error"): kid_event(events, use, "open", events[use]["at"], agent=agent)
                else: kid_event(events, use, "closed", at, agent=agent)
    elif kind == "assistant":
        content = (row.get("message") or {}).get("content")
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict) or block.get("type") != "tool_use": continue
            args = block.get("input") if isinstance(block.get("input"), dict) else {}
            if block.get("name") in ("Agent", "Task") and block.get("id"):
                kid_event(events, block["id"], "open", at, d=str(args.get("description") or "")[:100], role=str(args.get("subagent_type") or "")[:60])
            elif block.get("name") == "SendMessage" and isinstance(args.get("to"), str):
                for key, value in events.items():
                    if value.get("agent") == args["to"]:
                        kid_event(events, key, "open", at); break
    if isinstance(note, str):
        found = NOTE_RE.search(note)
        if found:
            task, use = found.group(1), found.group(2)
            key = use if use in events else next((k for k, v in events.items() if v.get("agent") == task), None)
            if key: kid_event(events, key, "closed", at)


def codex_kid_row(row, events):
    if row.get("type") != "response_item": return
    value = row.get("payload") or {}
    at = iso_epoch(row.get("timestamp"))
    kind = value.get("type")
    if kind in ("function_call", "custom_tool_call"):
        name, raw = value.get("name"), value.get("arguments", value.get("input", ""))
        calls = []
        if name in ("spawn_agent", "followup_task"):
            try: args = json.loads(raw) if isinstance(raw, str) else raw
            except ValueError: args = {}
            if isinstance(args, dict): calls.append(args.get("task_name") or args.get("target"))
        elif isinstance(raw, str):
            calls.extend(m.group(2) for m in CODE_SPAWN_RE.finditer(raw))
        for task in calls:
            if isinstance(task, str) and task.strip("/"): kid_event(events, task.rstrip("/").rsplit("/", 1)[-1], "open", at)
    elif kind == "agent_message":
        author = str(value.get("author") or "").rstrip("/").rsplit("/", 1)[-1]
        if author in events and "Message Type: FINAL_ANSWER" in text_content(value.get("content", [])):
            kid_event(events, author, "closed", at)


def kid_parent_events(path, provider):
    """Open/closed sub-agent records from the parent transcript, read incrementally."""
    state = kids_state(); info = path.stat()
    key = hashlib.sha256((provider + ":" + str(path)).encode()).hexdigest()[:32]
    entry = state["parents"].get(key)
    if not isinstance(entry, dict) or entry.get("ino") != info.st_ino or entry.get("off", 0) > info.st_size or not isinstance(entry.get("ev"), dict):
        entry = {"ino": info.st_ino, "off": 0, "ev": {}}
    entry["used"] = time.time()
    state["parents"][key] = entry; state["dirty"] = True
    if entry["off"] >= info.st_size: return entry["ev"]
    marks, handle_row = (CLAUDE_KID_MARKS, claude_kid_row) if provider == "claude" else (CODEX_KID_MARKS, codex_kid_row)
    events = entry["ev"]
    with path.open("rb") as stream:
        stream.seek(entry["off"])
        data = stream.read(min(KIDS_SCAN, info.st_size - entry["off"]))
    end = data.rfind(b"\n") + 1
    for line in data[:end].split(b"\n"):
        if not line: continue
        wanted = bool(marks.search(line))
        if not wanted and provider == "claude" and events and b'"tool_use_id"' in line:
            wanted = any(m.decode() in events for m in TOOL_RESULT_ID_RE.findall(line))
        if not wanted: continue
        try: row = json.loads(line)
        except (ValueError, UnicodeError): continue
        if isinstance(row, dict):
            try: handle_row(row, events)
            except (AttributeError, TypeError): continue
    entry["off"] += end
    return events


def claude_kid_tail(path):
    """"done" when the child's last turn ended, "busy" mid-turn, "" when unreadable."""
    size = path.stat().st_size
    with path.open("rb") as stream:
        stream.seek(max(0, size - KIDS_TAIL)); data = stream.read(KIDS_TAIL)
    for line in reversed(data.split(b"\n")):
        if not CLAUDE_TURN_MARK.search(line): continue
        try: row = json.loads(line)
        except (ValueError, UnicodeError): continue
        if not isinstance(row, dict) or row.get("type") not in ("user", "assistant") or row.get("isMeta"): continue
        if row["type"] == "user": return "busy"
        message = row.get("message") or {}
        content = message.get("content") if isinstance(message.get("content"), list) else []
        if any(isinstance(b, dict) and b.get("type") == "tool_use" for b in content): return "busy"
        return "done" if message.get("stop_reason") in ("end_turn", "stop_sequence", "max_tokens", "refusal") else "busy"
    return ""


def codex_kid_tail(path):
    size = path.stat().st_size
    with path.open("rb") as stream:
        stream.seek(max(0, size - KIDS_TAIL * 4)); data = stream.read(KIDS_TAIL * 4)
    for line in reversed(data.split(b"\n")):
        if b"task_started" not in line and b"task_complete" not in line and b"turn_aborted" not in line: continue
        try: row = json.loads(line)
        except (ValueError, UnicodeError): continue
        kind = (row.get("payload") or {}).get("type") if isinstance(row, dict) and row.get("type") == "event_msg" else None
        if kind == "task_started": return "busy"
        if kind in ("task_complete", "turn_aborted"): return "done"
    return ""


def kid_running(age, mtime, tail, parent):
    if tail == "done": return False
    if parent and parent.get("s") == "closed" and parent.get("at", 0) >= mtime - 5: return False
    if age < KIDS_ACTIVE: return True
    opened = bool(parent and parent.get("s") == "open")
    if tail == "busy": return age < (KIDS_OPEN if opened else KIDS_QUIET)
    return opened and age < KIDS_OPEN


def kid_meta(provider, root, path, info):
    """Catalog metadata for a child, cached once its title is final (titles do not change)."""
    state = kids_state(); rel = str(path.relative_to(root))
    saved = state["meta"].get(rel)
    if isinstance(saved, dict) and saved.get("ino") == info.st_ino and isinstance(saved.get("m"), dict): meta = saved["m"]
    else:
        meta = record_meta(path, provider)
        if not meta: return None
        if meta["title"] not in (meta.get("role"), "") and not meta["title"].startswith("对话 · "):
            state["meta"][rel] = {"ino": info.st_ino, "m": meta}; state["dirty"] = True
    key = hashlib.sha256((provider + ":" + rel).encode()).hexdigest()
    return dict(meta, id=key, modified=info.st_mtime, size=info.st_size)


def claude_kid_link(child):
    """The parent's tool_use id for a Claude sub-agent, from its .meta.json."""
    side = child.with_name(child.stem + ".meta.json")
    try:
        if not side.is_symlink() and side.stat().st_size <= 65536:
            return str(json.loads(side.read_text()).get("toolUseId") or "")
    except (OSError, ValueError, AttributeError): pass
    return ""


def claude_kid_files(path):
    folder = path.parent / path.stem / "subagents"
    try: names = list(folder.glob("agent-*.jsonl"))
    except OSError: return []
    return [(child, claude_kid_link(child), child.stem.removeprefix("agent-")) for child in names if not child.is_symlink()]


def kid_self(entry, now=None):
    """Whether a sub-agent record itself still runs: its own tail, then its parent's record."""
    path, provider = entry["_path"], entry["provider"]
    info = path.stat(); now = now or time.time()
    tail = claude_kid_tail(path) if provider == "claude" else codex_kid_tail(path)
    parent = None
    try:
        if provider == "claude" and path.parent.name == "subagents":
            home = path.parent.parent
            source = home.parent / (home.name + ".jsonl")
            if source.is_file() and not source.is_symlink():
                events = kid_parent_events(source, provider); link = claude_kid_link(path); agent = path.stem.removeprefix("agent-")
                parent = events.get(link) or next((v for v in events.values() if v.get("agent") == agent), None)
        elif provider == "codex" and re.fullmatch(UUID_RE, str(entry.get("parent") or "")):
            root = provider_root(provider)
            found = [p for p in root.glob("*/*/*/rollout-*" + entry["parent"] + ".jsonl") if not p.is_symlink()] if root else []
            if found: parent = kid_parent_events(found[0], provider).get(entry.get("role") or "")
    except OSError: parent = None
    return {"running": kid_running(now - info.st_mtime, info.st_mtime, tail, parent)}


def codex_kid_files(path, thread, root):
    """Rollouts forked from this thread: same day or later folders, newer file names only."""
    state = kids_state(); out = []
    try:
        day = path.parent; start = time.mktime(time.strptime("/".join(day.parts[-3:]), "%Y/%m/%d"))
    except (ValueError, OverflowError): return out
    for n in range(KIDS_DAYS):
        folder = root / time.strftime("%Y/%m/%d", time.localtime(start + n * 86400 + 3600))
        if not folder.is_dir():
            if start + n * 86400 > time.time(): break
            continue
        for child in folder.glob("rollout-*.jsonl"):
            if child == path or (folder == day and child.name < path.name) or child.is_symlink(): continue
            rel = str(child.relative_to(root)); parent = state["heads"].get(rel)
            if parent is None:
                parent = ""
                try:
                    with child.open("rb") as stream: head = json.loads(stream.readline(2_000_001))
                    value = head.get("payload", {}) if head.get("type") == "session_meta" else {}
                    source = value.get("source") if isinstance(value.get("source"), dict) else {}
                    sub = source.get("subagent") if isinstance(source.get("subagent"), dict) else {}
                    spawn = sub.get("thread_spawn") if isinstance(sub.get("thread_spawn"), dict) else {}
                    if sub.get("other") not in ("guardian", "review"):
                        parent = str(value.get("parent_thread_id") or spawn.get("parent_thread_id") or "")
                except (OSError, ValueError, AttributeError): continue
                state["heads"][rel] = parent; state["dirty"] = True
            if parent == thread: out.append((child, "", ""))
    return out


def kids_report(path, provider, thread, now=None):
    """{total, running, items[≤KIDS_LIST]: record + running/state}. Running first, then newest."""
    root = provider_root(provider)
    if not root or not path: return {"total": 0, "running": 0, "items": []}
    now = now or time.time()
    events = kid_parent_events(path, provider)
    files = claude_kid_files(path) if provider == "claude" else codex_kid_files(path, thread, root)
    rows, seen = [], set()
    for child, link, agent in files:
        try:
            info = child.stat()
            parent = events.get(link) or next((v for v in events.values() if agent and v.get("agent") == agent), None)
            tail = claude_kid_tail(child) if provider == "claude" else codex_kid_tail(child)
        except OSError: continue
        if provider == "codex":
            meta = kid_meta(provider, root, child, info)
            if not meta: continue
            parent = events.get(meta.get("role") or "")
            if parent: seen.add(meta["role"])
        else:
            meta = None
            if link: seen.add(link)
            if parent and parent.get("agent"): seen.add(parent["agent"])
        running = kid_running(now - info.st_mtime, info.st_mtime, tail, parent)
        rows.append({"running": running, "at": info.st_mtime, "path": child, "info": info, "meta": meta})
    starting = [dict(provider=provider, thread="", parent=thread, id="", cwd="", title=v.get("d") or "子 Agent", role=v.get("role") or "",
                     modified=v["at"], running=True, state="starting")
                for k, v in events.items() if v.get("s") == "open" and k not in seen and v.get("agent") not in seen and now - v.get("at", 0) < KIDS_STARTING]
    rows.sort(key=lambda r: (not r["running"], -r["at"]))
    items = list(starting)
    for row in rows[:max(0, KIDS_LIST - len(items))]:
        meta = row["meta"] or kid_meta(provider, root, row["path"], row["info"])
        if meta: items.append(dict(public_record(meta), running=row["running"], state="running" if row["running"] else "done"))
    running = sum(1 for r in rows if r["running"]) + len(starting)
    # Same stamp = same answer: which sub-agents exist, which run, how the newest ones look.
    stamp = hashlib.sha256(json.dumps([path.stat().st_size, [(r["path"].name, r["running"]) for r in rows], [x.get("title") for x in items]],
                                      ensure_ascii=False).encode()).hexdigest()[:20]
    return {"total": len(rows) + len(starting), "running": running, "items": items, "stamp": stamp}


def kids_for_item(item):
    """Glance / remote entry: the report for one record named by provider, thread and record id."""
    path = glance_path(item)
    if not path: return None
    report = kids_report(path, item["provider"], item["thread"])
    if item.get("kids_stamp") == report["stamp"] and not report["running"]: return {"same": True}
    return report


def attach_kids(result, catalog, request):
    """History pages also carry the record's sub-agents, so an open chat stays current."""
    if "before" in request: return result
    entry = next((x for x in catalog if x["id"] == request.get("record_id")), None)
    if not entry: return result
    try:
        result["kids"] = kids_report(entry["_path"], entry["provider"], entry["thread"])
        if entry.get("parent"): result["kid"] = kid_self(entry)
    except OSError: pass
    finally: kids_save()
    return result


def remote_kids(items):
    """ch panes: one read per remote account (all its panes together), accounts in parallel,
    through the same verified remote helper as history."""
    out, groups, routes, memo = {}, {}, {}, {}
    for item in items:
        context = item["remote"]; key = item["key"]
        try:
            ckey = json.dumps(context, sort_keys=True)
            if ckey not in routes: routes[ckey] = route_for_context(context, memo)
            route = routes[ckey]
        except (BridgeError, KeyError, TypeError) as exc:
            out[key] = {"kids_error": str(exc)[:200]}; continue
        prefix = "remote:" + route["key"] + ":"; record = item.get("record_id")
        if not isinstance(record, str) or not record.startswith(prefix) or not re.fullmatch(r"[a-f0-9]{64}", record[len(prefix):]):
            out[key] = {"kids_error": "Invalid remote history record"}; continue
        group = groups.setdefault(json.dumps(route["ssh"]), {"route": route, "items": [], "places": {}})
        group["items"].append({"key": key, "provider": item.get("provider"), "thread": item.get("thread"), "record_id": record[len(prefix):],
                               "kids_stamp": item.get("kids_stamp")})
        group["places"][key] = (route, context)
    def run(group):
        try: return remote_read(group["route"], {"op": "kids", "items": group["items"]}, 12).get("kids", {})
        except BridgeError as exc: return exc
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=max(1, min(8, len(groups)))) as pool:
        answers = list(pool.map(run, groups.values()))
    for group, data in zip(groups.values(), answers):
        for x in group["items"]:
            if isinstance(data, BridgeError): out[x["key"]] = {"kids_error": str(data)[:200]}; continue
            report = data.get(x["key"]) if isinstance(data, dict) else None
            if not isinstance(report, dict): out[x["key"]] = {"kids_error": "远端没有返回子 Agent"}; continue
            route, context = group["places"][x["key"]]
            if isinstance(report.get("items"), list):
                report["items"] = [wrap_remote_record(r, route, context) if r.get("id") else r for r in report["items"] if isinstance(r, dict)]
            out[x["key"]] = {"kids": report}
    return out


def remote_kids_main(items):
    """Runs on the other computer."""
    out = {}
    for item in items[:GLANCE_ITEMS] if isinstance(items, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("key"), str): continue
        try: out[item["key"]] = kids_for_item(item) or {"missing": True}
        except OSError: out[item["key"]] = {"missing": True}
    kids_save()
    return {"kids": out}


# ─── Agent modes ────────────────────────────────────────────────────────────
# What the agent's own footer says about its mode, read from the same screen read the chat
# already makes. Only the footer under the input box counts (never conversation text), and a
# screen without that footer (a menu, a full-screen dialog) reports nothing rather than a guess.
#
# Claude Code (2.1.x) prints one permission mode under its input box and cycles it with
# Shift+Tab: manual → accept edits → plan → [bypass, when started with it] → [auto, when
# available] → manual. A /goal is separate: "◎ /goal active (3m)" sits next to the mode.
#   ⏸ manual mode on · ← for agents
#   ⏵⏵ accept edits on (shift+tab to cycle)
#   ⏸ plan mode on (shift+tab to cycle) · ◎ /goal active (3m)
#   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
# Codex (0.16x) cycles only its collaboration mode with Shift+Tab (Default ↔ Plan); Default
# shows nothing, Plan shows "Plan mode (shift+tab to cycle)" at the right of the status line.
# Approval presets (/approvals) are not on screen and Shift+Tab does not change them; the
# transcript's turn_context records them (glance). A Codex goal is separate as well:
# "Pursuing goal (5m)", "Goal paused (/goal resume)", …
CLAUDE_MODES = {"manual mode": "default", "accept edits": "acceptEdits", "plan mode": "plan", "auto mode": "auto",
                "bypass permissions": "bypassPermissions", "don't ask": "dontAsk"}
CLAUDE_MODE_RE = re.compile(r"(?:⏵⏵|⏸)\s*(manual mode|accept edits|plan mode|auto mode|bypass permissions|don't ask)(?: on)?")
CLAUDE_GOAL_RE = re.compile(r"/goal active(?: \(([^)]{1,20})\))?")
CODEX_PLAN_RE = re.compile(r"\b(Plan|Pair Programming|Execute) mode\b(?: \(shift ?\+ ?tab to cycle\))?")
CODEX_GOALS = (("Pursuing goal", "active"), ("Goal paused", "paused"), ("Goal stalled", "blocked"),
               ("Goal hit usage limits", "usage_limited"), ("Goal unmet", "unmet"), ("Goal achieved", "complete"))
CODEX_GOAL_RE = re.compile(r"(Pursuing goal|Goal paused|Goal stalled|Goal hit usage limits|Goal unmet|Goal achieved)(?: \(([^)]{1,30})\))?")
CODEX_FOOTER_RE = re.compile(r"for shortcuts|esc to interrupt|Context \d+% used|% context left|to cycle\)|tab to queue")
RULE_RE = re.compile(r"^\s*[─━]{8,}")


def screen_lines(text):
    lines = [x.rstrip() for x in str(text or "").split("\n")]
    while lines and not lines[-1].strip(): lines.pop()
    return lines[-60:]


def claude_footer(lines):
    """Lines under Claude's input box (two rules around a ❯ line), or None when no box is on screen."""
    rules = [i for i, x in enumerate(lines) if RULE_RE.match(x)]
    for j in reversed(rules):
        before = [i for i in rules if i < j]
        if before and any(x.lstrip().startswith("❯") for x in lines[before[-1] + 1:j]):
            return lines[j + 1:j + 7]
    return None


def codex_footer(lines):
    """Lines under Codex's composer (the last › line), when they look like its footer."""
    for i in range(len(lines) - 1, max(-1, len(lines) - 25), -1):
        if lines[i].lstrip().startswith("›"):
            foot = lines[i + 1:i + 13]
            return foot if any(CODEX_FOOTER_RE.search(x) for x in foot) else None
    return None


def screen_modes(text, provider):
    """{agent, permission|collaboration, goal, cycle} from the footer, or None when it is not on screen."""
    lines = screen_lines(text)
    if provider == "claude":
        foot = claude_footer(lines)
        if foot is None: return None
        joined = "\n".join(foot)
        found = CLAUDE_MODE_RE.search(joined)
        permission = CLAUDE_MODES[found.group(1)] if found else ("default" if "? for shortcuts" in joined else None)
        goal = CLAUDE_GOAL_RE.search(joined)
        return {"agent": "claude", "permission": permission,
                "goal": {"state": "active", "elapsed": goal.group(1) or ""} if goal else None,
                "cycle": "shift+tab to cycle" in joined or bool(found)}
    if provider == "codex":
        foot = codex_footer(lines)
        if foot is None: return None
        joined = "\n".join(foot)
        found = CODEX_PLAN_RE.search(joined)
        # A truncated status line ("…") may have pushed the right-aligned mode label out of view.
        collaboration = found.group(1).lower().replace(" ", "_") if found else (None if any(x.endswith("…") for x in foot) else "default")
        goal = CODEX_GOAL_RE.search(joined)
        return {"agent": "codex", "collaboration": collaboration,
                "goal": {"state": dict(CODEX_GOALS)[goal.group(1)], "elapsed": (goal.group(2) or "") if goal.group(1) in ("Pursuing goal", "Goal unmet", "Goal achieved") else ""} if goal else None,
                "cycle": True}
    return None


def transcript_modes(row, provider, modes):
    """Mode settings a transcript row records (the newest row wins): Claude writes permissionMode
    on user entries; Codex writes collaboration mode and approval settings in each turn_context."""
    if provider == "claude":
        mode = row.get("permissionMode")
        if isinstance(mode, str) and mode in CLAUDE_MODES.values(): modes["permission"] = mode; modes["at"] = row.get("timestamp") or ""
        return
    if row.get("type") != "turn_context" or not isinstance(row.get("payload"), dict): return
    p = row["payload"]
    collab = p.get("collaboration_mode")
    if isinstance(collab, dict) and isinstance(collab.get("mode"), str) and re.fullmatch(r"[a-z_]{1,24}", collab["mode"]):
        modes["collaboration"] = collab["mode"]
    if isinstance(p.get("approval_policy"), str) and len(p["approval_policy"]) <= 24: modes["approval"] = p["approval_policy"]
    sandbox = p.get("sandbox_policy")
    if isinstance(sandbox, dict) and isinstance(sandbox.get("type"), str) and len(sandbox["type"]) <= 32: modes["sandbox"] = sandbox["type"]
    modes["at"] = row.get("timestamp") or ""


def codex_goal(thread):
    """A Codex thread's goal from its own goals database (read-only), or None."""
    files = sorted((Path.home() / ".codex").glob("goals_*.sqlite"))
    if not files or not isinstance(thread, str) or not re.fullmatch(UUID_RE, thread): return None
    try:
        with closing(sqlite3.connect("file:" + uri_quote(str(files[-1])) + "?mode=ro", uri=True, timeout=0.5)) as db:
            row = db.execute("SELECT status, objective, updated_at_ms FROM thread_goals WHERE thread_id=?", (thread,)).fetchone()
    except sqlite3.Error: return None
    if not row: return None
    return {"state": str(row[0])[:24], "objective": glance_line(str(row[1] or ""), 120), "updated": (row[2] or 0) / 1000}


# ─── Following one pane ─────────────────────────────────────────────────────
# The conversation inside a pane can change under an open chat: Claude /clear or
# /resume, Codex /new or /resume, or the agent exits and the pane is a shell again.
# `agents` with a `target` re-resolves just that pane with the same evidence order
# as the full list, without walking every other pane. Read-only.
PANE_FIELDS = ("pane_id", "terminal_id", "terminal_title", "terminal_title_stripped", "cwd", "foreground_cwd",
               "workspace_id", "tab_id")


def with_record(ref, catalog):
    """Attach the public record to a local match so the app can open it without a catalog round trip."""
    if ref.get("status") == "matched" and not ref.get("record"):
        entry = next((x for x in catalog if x["id"] == ref.get("record_id")), None)
        if entry: ref = dict(ref, record=public_record(entry))
    return ref


def resolve_one(agent, prefix):
    provider = agent["agent"]
    probe = probe_pane(agent, prefix, provider)
    # Fast path: a local Claude keeps its current runtime session directory open, which
    # already reflects /clear and /resume; locate just that file instead of scanning all.
    if provider == "claude" and not probe["route"] and len(probe["active"]) == 1:
        thread = next(iter(probe["active"]))
        entry = locate_thread(provider, thread, probe["cwd"] or agent.get("foreground_cwd") or agent.get("cwd") or "")
        if entry: return dict(matched(entry, "native-process"), record=public_record(entry))
        return {"status": "pending", "thread": thread, "source": "native-process", "reason": "会话刚开始，历史文件还没写出"}
    if probe["route"]:
        global _remote_deadline
        _remote_deadline = time.monotonic() + 15
        _remote_results.clear()
        try: return resolve_agent_history(agent, prefix, [], None, probe)
        finally: _remote_deadline = None
    catalog = transcript_catalog()
    index = (codex_thread_names(), codex_loaded_threads()) if provider == "codex" else None
    return with_record(resolve_agent_history(agent, prefix, catalog, index, probe), catalog)


def follow_pane(request, prefix):
    target = request.get("target")
    if not isinstance(target, str) or not re.fullmatch(r"w[A-Za-z0-9]+:p[A-Za-z0-9]+", target):
        raise BridgeError("Invalid pane target")
    agent = next((a for a in agents(prefix) if a.get("pane_id") == target), None)
    if agent:
        if agent.get("agent") in ("codex", "claude"): agent["history_ref"] = resolve_one(agent, prefix)
        state = "same" if agent["identity"] == request.get("identity") else "changed"
        return {"follow": True, "state": state, "agents": [agent], "pane": None}
    # No agent in the pane any more: tell "exited, the shell is still there" from "pane closed".
    try: live = call(prefix + ["pane", "get", target])
    except BridgeError as exc:
        if "not_found" in str(exc) or "not found" in str(exc): return {"follow": True, "state": "gone", "agents": [], "pane": None}
        raise
    pane = live.get("pane", live)
    if pane.get("pane_id") != target: return {"follow": True, "state": "gone", "agents": [], "pane": None}
    if pane.get("agent"):
        # Herdr's pane view caught an agent the list did not have yet; report it on the next poll.
        return {"follow": True, "state": "starting", "agents": [], "pane": None}
    public = {k: pane.get(k) for k in PANE_FIELDS}
    public["identity"] = identity(pane)
    return {"follow": True, "state": "exited", "agents": [], "pane": public}


# ─── Agent questions and approval menus ──────────────────────────────────────
# Claude's AskUserQuestion / permission dialogs and Codex's approval / question
# pickers are numbered TUI menus with a pointer on the focused row. The phone
# picks an option; the bridge walks the cursor there with ↑/↓, re-reads the
# screen to confirm the pointer really sits on that option, and only then
# presses Enter. Anything unexpected stops before Enter.
# Scrolling lists may put ↑/↓ in the pointer column of the first/last visible row.
MENU_ROW = re.compile(r"^(?:[↑↓][ \t]*)?(?P<ptr>[❯›>▶➤])?[ \t]*(?:[↑↓][ \t]*)?(?P<n>\d{1,2})\.[ \t]+(?P<rest>\S.*)$")
MENU_SUBMIT = re.compile(r"^(?P<ptr>[❯›>▶➤])?[ \t]*(?P<label>Submit answers|Submit|Next)[ \t]*$")
MENU_CHECK = re.compile(r"^(?:\[(?P<box>[ ✔✓×xX√])\]|(?P<sym>[☐☒◻◼]))[ \t]*")
MENU_FOOTER = re.compile(r"(?i)(enter to |esc to |to navigate|tab to |to cancel|ctrl\+\w to |press enter|↑/↓|←/→)")
MENU_MORE = re.compile(r"^[↑↓]\s*(\d+\s*more (above|below).*)?$")
MENU_INPUT = re.compile(r"(?i)^(type something|type your answer|other)\b")
BOX_EDGE = "│┃║"
BOX_INNER = "│┃║┌┐└┘├┤┬┴┼╭╮╰╯"
ANSWER_KEYS_LIMIT = 24
ANSWER_PAUSE, ANSWER_PATIENCE = 0.2, 4.0  # screen re-read interval / how long a TUI may take to redraw


def menu_rule(line):
    stripped = line.strip()
    return len(stripped) >= 8 and sum(c in "─━═╌┄-_" for c in stripped) >= len(stripped) * 0.8


def menu_clean(line):
    line = line.rstrip()
    # Only a dialog border at the left edge; a side panel (Claude's option preview) stays and is cut later.
    line = re.sub(r"^[ \t]{0,2}[" + BOX_EDGE + r"][ \t]?", "", line)
    return re.sub(r"[ \t]*[" + BOX_EDGE + r"]$", "", line)


def menu_norm(text):
    return re.sub(r"\s+", "", str(text or "")).lower()


def menu_loose_match(a, b):
    """Screen labels may be truncated or wrapped; compare a stable prefix."""
    a, b = menu_norm(a).rstrip("…."), menu_norm(b).rstrip("….")
    if not a or not b: return False
    size = min(len(a), len(b), 12)
    return a[:size] == b[:size]


def parse_menu(text, provider=""):
    """Find the newest numbered menu at the bottom of an agent screen; None if unsure."""
    lines = [menu_clean(x) for x in str(text or "").split("\n")][-70:]
    runs = []
    for index, raw in enumerate(lines):
        match = MENU_ROW.match(raw.strip())
        if not match: continue
        n = int(match["n"])
        if not runs or n != runs[-1][-1]["n"] + 1: runs.append([])
        runs[-1].append({"n": n, "line": index, "ptr": bool(match["ptr"]), "rest": match["rest"]})
    # The live menu is the last run; earlier runs are numbered lists in the transcript.
    runs = [r for r in runs if len(r) >= 2]
    if not runs: return None
    run = runs[-1]
    last_line = run[-1]["line"]
    # A live menu sits at the bottom: only a submit row, hints and blank lines may follow.
    if sum(1 for x in lines[last_line + 1:] if x.strip()) > 14: return None
    submit, cursor = None, None
    for index in range(last_line + 1, min(len(lines), last_line + 12)):
        match = MENU_SUBMIT.match(lines[index].strip())
        if match:
            submit = {"label": match["label"], "line": index}
            if match["ptr"]: cursor = "submit"
            break
    for row in run:
        rest = row["rest"]
        cut = min([rest.find(c) for c in BOX_INNER if c in rest] or [len(rest)])
        rest = rest[:cut].rstrip()
        check = MENU_CHECK.match(rest)
        checked = None
        if check:
            checked = (check["box"] or "").strip() != "" if check["box"] is not None else check["sym"] in "☒◼"
            rest = rest[check.end():]
        chosen = bool(re.search(r"\s[✔✓]$", rest))
        rest = re.sub(r"\s[✔✓]$", "", rest).strip()
        # Codex prints the description on the same line after a wide gap.
        parts = re.split(r"\s{2,}", rest, maxsplit=1)
        row.update(label=parts[0].strip(), checked=checked, chosen=chosen, description=parts[1].strip() if len(parts) > 1 else "")
        if row["ptr"]:
            if cursor is not None: return None  # two pointers: not a menu we understand
            cursor = row["n"]
    # Description lines sit under each row until the next row or the footer.
    ends = [r["line"] for r in run[1:]] + [submit["line"] if submit else len(lines)]
    for row, end in zip(run, ends):
        extra = []
        for raw in lines[row["line"] + 1:end]:
            value = raw.strip()
            if not value: continue
            if menu_rule(raw) or MENU_FOOTER.search(value) or MENU_MORE.match(value) or MENU_SUBMIT.match(value): break
            value = value[:min([value.find(c) for c in BOX_INNER if c in value] or [len(value)])].strip()
            if value: extra.append(value)
        description = " ".join(([row["description"]] if row["description"] else []) + extra)
        row["description"] = description[:600]
    if cursor is None: return None
    # Context: the dialog text above the options (question, command to approve…).
    context, tabs = [], []
    for raw in reversed(lines[max(0, run[0]["line"] - 16):run[0]["line"]]):
        value = raw.strip()
        if menu_rule(raw) and context: break
        if menu_rule(raw) or MENU_MORE.match(value): continue
        if "←" in value and "→" in value and re.search(r"[☐☒✔√]", value):
            tabs = [{"label": m[2].strip(), "done": m[1] in "☒✔√"}
                    for m in re.finditer(r"([☐☒✔√])\s+([^☐☒✔√←→]+)", value)]
            break
        context.insert(0, value[:300])
    while context and not context[0]: context.pop(0)
    while context and not context[-1]: context.pop()
    context = context[-14:]
    question = next((x for x in reversed(context) if x.endswith(("?", "？"))), next((x for x in reversed(context) if x), ""))
    words = " ".join(context + [r["label"] for r in run]).lower()
    labels = [r["label"] for r in run]
    if "review your answers" in words or "submit answers" in [x.lower() for x in labels]: kind = "review"
    elif re.search(r"do you want to|would you like to|allow |approve|permission|proceed\?", words): kind = "approval"
    else: kind = "question"
    chat = next((r["n"] for r in run if r["label"].lower().startswith("chat about this")), None)
    multi = any(r["checked"] is not None for r in run)
    for row in run:
        row["chat"] = row["n"] == chat
        # Only Claude question dialogs have a text row; elsewhere typed letters may be shortcuts (y/n/p).
        row["input"] = provider == "claude" and kind == "question" and (
            bool(MENU_INPUT.match(row["label"])) or row["n"] == (chat or 0) - 1 or bool(multi and submit and row is run[-1]))
    stable = [kind, multi, context, [(r["n"], r["label"]) for r in run if not r["input"]]]
    return {"kind": kind, "multi": multi, "cursor": cursor, "question": question, "context": context,
            "tabs": [t for t in tabs if t["label"].lower() != "submit"],
            "options": [{k: r[k] for k in ("n", "label", "description", "checked", "chosen", "input", "chat")} for r in run],
            "submit": submit["label"] if submit else None,
            "fingerprint": hashlib.sha256(json.dumps(stable, ensure_ascii=False).encode()).hexdigest()[:20]}


def with_menu(screen, agent, always=False):
    """Attach the parsed menu to a read while the agent waits on one.

    The read also carries Herdr's state from the same request, so the phone sees
    "blocked" as soon as it reads the screen instead of waiting for a status poll."""
    screen["agent_status"] = agent.get("agent_status")
    if always or agent.get("agent_status") == "blocked":
        screen["menu"] = parse_menu(screen.get("text", ""), agent.get("agent", ""))
    return screen


def validate_answer(request):
    action = request.get("action")
    if action not in ("select", "multi", "text"): raise BridgeError("Unsupported answer action")
    if not isinstance(request.get("fingerprint"), str) or not re.fullmatch(r"[a-f0-9]{20}", request["fingerprint"]):
        raise BridgeError("Answer requires the menu fingerprint")
    def number(value):
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 20: raise BridgeError("Invalid option number")
        return value
    if action in ("select", "text"): number(request.get("option"))
    if action == "multi":
        options = request.get("options")
        if not isinstance(options, list) or len(options) > 20: raise BridgeError("Invalid option list")
        for value in options: number(value)
        if request.get("text") is not None: number(request.get("option"))
    labels = request.get("labels", {})
    if not isinstance(labels, dict) or len(labels) > 20 or any(
            not re.fullmatch(r"\d{1,2}", k) or not isinstance(v, str) or len(v) > 400 for k, v in labels.items()):
        raise BridgeError("Invalid option labels")
    label = request.get("label", "")
    if not isinstance(label, str) or len(label) > 400: raise BridgeError("Invalid option label")
    text = request.get("text")
    if action == "text" or text is not None:
        # Typed into the TUI byte for byte: a newline or control character would act as a key.
        if not isinstance(text, str) or not text.strip() or len(text) > 2000 or re.search(r"[\x00-\x1f\x7f]", text):
            raise BridgeError("回答文字要在一行内，最多 2000 字，不能含换行或控制字符")


def menu_consistent(base, current):
    """Same dialog: scrolling may hide/reveal rows, but no visible row may change meaning."""
    if (current["kind"], current["multi"], current["context"]) != (base["kind"], base["multi"], base["context"]): return False
    seen = {r["n"]: r for r in base["options"]}
    return all(r["input"] or r["n"] not in seen or seen[r["n"]]["input"] or r["label"] == seen[r["n"]]["label"]
               for r in current["options"])


def answer_question(request, prefix, agent):
    """Drive a blocked agent's menu to the chosen option(s); Enter only on a verified cursor.

    Every key is sent on its own and followed by a screen read: the cursor must move exactly
    one row in the expected direction inside the same dialog, otherwise we stop before Enter.
    """
    target = agent["pane_id"]
    steps = []

    def screen():
        text = read_screen(prefix, agent, 80).get("text", "")
        return parse_menu(text, agent.get("agent", ""))

    def press(name):
        if len(steps) >= ANSWER_KEYS_LIMIT * 2: raise BridgeError("按键太多，已停下")
        call(prefix + (["pane", "send-keys", target, name] if agent.get("relay") else ["agent", "send-keys", target, name]))
        steps.append(name)

    base = screen()
    if not base: raise BridgeError("屏幕上没有找到可选择的菜单，用按键操作看看")
    if base["fingerprint"] != request["fingerprint"]: raise BridgeError("选项已经变了，刷新后再选")
    labels = {int(k): v for k, v in request.get("labels", {}).items()}
    if request.get("label") and request.get("option"): labels.setdefault(request["option"], request["label"])

    def wait(check, failure):
        deadline = time.monotonic() + ANSWER_PATIENCE
        while True:
            current = screen()
            if current and not menu_consistent(base, current):
                raise BridgeError("操作途中菜单变了，已停下，没有按确认")
            if current and check(current): return current
            if time.monotonic() > deadline: raise BridgeError(failure)
            time.sleep(ANSWER_PAUSE)

    def row(current, n):
        return next((r for r in current["options"] if r["n"] == n), None)

    def walk(current, goal):
        for _ in range(ANSWER_KEYS_LIMIT):
            cursor = current["cursor"]
            if cursor == goal: return current
            down = goal == "submit" or (cursor != "submit" and goal > cursor)
            press("down" if down else "up")
            ok = (lambda c: c == "submit" or c == cursor + 1) if down else (
                lambda c: isinstance(c, int) and (cursor == "submit" or c == cursor - 1))
            current = wait(lambda m: m["cursor"] != cursor, "光标没有移动，已停下，没有按确认")
            if not ok(current["cursor"]): raise BridgeError("光标移动和预期不一致，已停下，没有按确认")
        raise BridgeError("要移动的距离太远，已停下")

    def land(current, n, want_input=False):
        if row(current, n) and row(current, n)["chat"]: raise BridgeError("没有这个选项")
        current = walk(current, n)
        found = row(current, n)
        if not found or found["chat"]: raise BridgeError("没有这个选项")
        if want_input != found["input"]:
            raise BridgeError("这个选项不能填写文字" if want_input else "这是填写选项，请输入文字后再提交")
        if not want_input and labels.get(n) and not menu_loose_match(found["label"], labels[n]):
            raise BridgeError("光标所在选项和你选的不一致，已停下，没有按确认")
        return current

    def precheck(n, want_input=False):
        # Refuse obvious mismatches on visible rows before any key is sent.
        found = row(base, n)
        if found and (found["chat"] or found["input"] != want_input):
            raise BridgeError("没有这个选项" if found["chat"] else "这个选项不能填写文字" if want_input else "这是填写选项，请输入文字后再提交")

    action = request["action"]
    menu = base
    if action == "select":
        n = request["option"]
        precheck(n)
        menu = land(menu, n)
        press("enter")
        return {"answered": True, "option": n, "steps": steps}
    if action == "multi":
        if not base["multi"] or not base["submit"]: raise BridgeError("这不是多选菜单")
        for n in request["options"]: precheck(n)
    if action == "text" or request.get("text") is not None:
        n = request["option"]
        precheck(n, True)
        menu = land(menu, n, True)
        text = request["text"]
        call(prefix + ["pane", "send-text", target, text])
        steps.append("text")
        probe = menu_norm(text)[:8]
        menu = wait(lambda m: m["cursor"] == n and row(m, n) and probe in menu_norm(row(m, n)["label"] + row(m, n)["description"]),
                    "文字已经输进去了，但在屏幕上没核对到，已停下，没有按确认")
        if action == "text":
            press("enter")
            return {"answered": True, "option": n, "steps": steps}
    wanted = set(request["options"]) | ({request["option"]} if request.get("text") is not None else set())
    visible = {r["n"] for r in menu["options"] if not r["chat"]}
    for n in sorted(visible | wanted):
        current = row(menu, n)
        if current and current["checked"] is not None and bool(current["checked"]) == (n in wanted): continue
        if not current and n not in wanted: continue
        menu = land(menu, n, bool(current["input"]) if current else (n == request.get("option") and request.get("text") is not None))
        if bool(row(menu, n)["checked"]) != (n in wanted):
            press("enter")
            menu = wait(lambda m, n=n: row(m, n) and bool(row(m, n)["checked"]) == (n in wanted),
                        "勾选状态没有按预期变化，已停下，没有提交")
    menu = walk(menu, "submit")
    press("enter")
    return {"answered": True, "options": sorted(wanted), "steps": steps}


# ─── Images ─────────────────────────────────────────────────────────────────
# The phone uploads re-encoded pictures over SFTP to ~/.herdr-pocket/uploads/<day>/<sha256>.<ext>
# (plus a small <sha256>.thumb.jpg). A prompt names them by that relative name only; the bridge
# checks the hash and puts the absolute path into the prompt. For a pane that is a ch-cli route to
# another computer the path would mean nothing there, so the file is handed to `ch share-image`
# (it only caches it locally and prints a ch-file:// address the remote agent can fetch).
# The phone only ever reads back files under those two folders, or pictures embedded in a transcript.
UPLOAD_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})/([a-f0-9]{64})\.(jpg|png)")
CH_ADDRESS = re.compile(r"ch-file://([a-f0-9]{64})\.(png|jpg|jpeg|gif|webp)")
IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
UPLOAD_LIMIT = 8_000_000
# Largest picture sent back in one response: base64 of it must stay under the app's 2 MB cap.
SERVE_LIMIT = 1_350_000
THUMB_EDGE = 480
UPLOAD_KEEP_DAYS = 14


def uploads_root():
    return Path.home() / ".herdr-pocket/uploads"


def owned_file(path, root, limit):
    """A regular file of this user directly inside an un-symlinked root; never follows links."""
    try:
        if root.is_symlink() or path.is_symlink() or path.parent.is_symlink(): return None
        if not path.resolve().is_relative_to(root.resolve()): return None
        info = path.lstat()
    except OSError: return None
    if not stat_module.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > limit: return None
    return path


def upload_path(name):
    match = UPLOAD_NAME.fullmatch(name) if isinstance(name, str) else None
    if not match: raise BridgeError("Invalid image name")
    return owned_file(uploads_root() / name, uploads_root(), UPLOAD_LIMIT), match


def prompt_images(images, request, prefix, agent):
    if not isinstance(images, list) or not 1 <= len(images) <= 4:
        raise BridgeError("一条消息最多带 4 张图片")
    try: prune_uploads()
    except OSError: pass
    files = []
    for item in images:
        if not isinstance(item, dict): raise BridgeError("Invalid image")
        path, match = upload_path(item.get("name"))
        if not path: raise BridgeError("没发出去：图片还没传到电脑上，删掉重新选一下")
        if item.get("sha256") != match.group(2) or hashlib.sha256(path.read_bytes()).hexdigest() != match.group(2):
            raise BridgeError("没发出去：电脑上的图片和手机上的不一致，删掉重新选一下")
        files.append((path, match.group(2)))
    probe = probe_pane(agent, prefix, agent.get("agent") or "")
    if not probe["ok"]: raise BridgeError("没发出去：看不清这个窗格运行在哪台电脑上，刷新后再试")
    if probe["route"]: return [("remote", share_image(path, sha)) for path, sha in files]
    if probe["remote"] or request.get("remote"):
        raise BridgeError("没发出去：这个窗格连着别的电脑，又不是 ch 路由，图片传不过去")
    return [("local", str(path)) for path, _ in files]


def share_image(path, sha):
    binary = shutil.which("ch") or str(Path.home() / ".local/bin/ch")
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERDR_")}
    try:
        result = subprocess.run([binary, "share-image", str(path)], capture_output=True, text=True, timeout=20, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BridgeError("没发出去：图片没能交给 ch 共享（找不到 ch 或超时）") from exc
    address = result.stdout.strip()
    match = CH_ADDRESS.fullmatch(address)
    if result.returncode or not match or match.group(1) != sha:
        raise BridgeError("没发出去：图片没能交给 ch 共享（ch share-image 失败）")
    return address


def compose_prompt(text, refs):
    # One short line per picture after the person's words, so the agent knows to open it.
    lines = [{"local": "[图片] ", "remote": "[图片 · ch-local fetch] ", "file": "[文件] "}[kind] + ref for kind, ref in refs]
    body = text.rstrip()
    return (body + "\n\n" if body.strip() else "") + "\n".join(lines)


def embedded_image(block):
    """A picture pasted into a transcript: Claude base64 source or Codex data URL."""
    if not isinstance(block, dict): return None
    if block.get("type") == "image":
        source = block.get("source")
        if isinstance(source, dict) and source.get("type") == "base64" and isinstance(source.get("data"), str):
            return source.get("media_type", ""), source["data"]
    if block.get("type") == "input_image":
        url = block.get("image_url")
        if isinstance(url, dict): url = url.get("url")
        if isinstance(url, str):
            match = re.match(r"data:(image/[a-z+.-]+);base64,", url[:80])
            if match: return match.group(1), url[match.end():]
    return None


def fit_image(data, mime, variant):
    """Return picture bytes the phone may receive; shrink with Pillow when it is installed."""
    small = variant == "thumb" and len(data) > 200_000
    if len(data) <= SERVE_LIMIT and not small: return data, mime
    try:
        from io import BytesIO
        from PIL import Image
        with Image.open(BytesIO(data)) as picture:
            picture.thumbnail((THUMB_EDGE, THUMB_EDGE) if variant == "thumb" else (1600, 1600))
            if picture.mode not in ("RGB", "L"): picture = picture.convert("RGB")
            out = BytesIO(); picture.save(out, "JPEG", quality=80)
        if out.tell() <= SERVE_LIMIT: return out.getvalue(), "image/jpeg"
    except Exception:
        if len(data) <= SERVE_LIMIT: return data, mime
    raise BridgeError("图片太大，手机上看不了，在电脑上打开吧")


def image_payload(data, mime, variant):
    if mime not in IMAGE_TYPES.values(): raise BridgeError("不支持的图片格式")
    data, mime = fit_image(data, mime, variant)
    import base64
    return {"mime": mime, "data": base64.b64encode(data).decode(), "bytes": len(data)}


def cached_picture(sha, ext, variant):
    """An uploaded picture (or its thumbnail), else a ch attachment cached on this computer."""
    root = uploads_root()
    try: days = sorted((d for d in root.iterdir() if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d.name)), reverse=True) if root.is_dir() else []
    except OSError: days = []
    for day in days:
        names = ([sha + ".thumb.jpg"] if variant == "thumb" else []) + [sha + ".jpg", sha + ".png"]
        for name in names:
            path = owned_file(day / name, root, UPLOAD_LIMIT)
            if path: return path, "image/jpeg" if name.endswith(".jpg") else "image/png"
    attachments = Path.home() / ".local/share/ch/attachments"
    path = owned_file(attachments / (sha + "." + ext), attachments, 40_000_000)
    if path: return path, IMAGE_TYPES[ext]
    return None, None


def transcript_image(entry, item, block, variant):
    if not isinstance(item, str) or not re.fullmatch(r"\d{1,15}:\d{1,4}", item) or not isinstance(block, int) or isinstance(block, bool):
        raise BridgeError("Invalid image reference")
    offset = int(item.split(":")[0])
    if offset >= entry["_path"].stat().st_size: raise BridgeError("Invalid image reference")
    with entry["_path"].open("rb") as stream:
        stream.seek(offset); line = stream.readline(40_000_001)
    try: row = json.loads(line)
    except ValueError as exc: raise BridgeError("这张图片在记录里已经找不到了") from exc
    content = (row.get("payload", {}) if entry["provider"] == "codex" else row.get("message", {})).get("content")
    found = embedded_image(content[block]) if isinstance(content, list) and 0 <= block < len(content) else None
    if not found: raise BridgeError("这张图片在记录里已经找不到了")
    import base64, binascii
    try: data = base64.b64decode(found[1], validate=False)
    except (binascii.Error, ValueError) as exc: raise BridgeError("图片数据损坏") from exc
    return image_payload(data, found[0], variant)


def image_request(request):
    variant = request.get("variant", "thumb")
    if variant not in ("thumb", "full"): raise BridgeError("Invalid image variant")
    kind = request.get("kind")
    if kind == "upload":
        path, match = upload_path(request.get("name"))
        sha = match.group(2); ext = match.group(3)
    elif kind == "ch":
        match = CH_ADDRESS.fullmatch(request.get("address", "")) if isinstance(request.get("address"), str) else None
        if not match: raise BridgeError("Invalid image address")
        sha, ext = match.groups()
    elif kind == "transcript":
        if request.get("remote") is not None:
            route = route_for_context(request["remote"]); key = request.get("record_id", ""); prefix = "remote:" + route["key"] + ":"
            if not isinstance(key, str) or not key.startswith(prefix) or not re.fullmatch(r"[a-f0-9]{64}", key[len(prefix):]):
                raise BridgeError("Invalid remote history record")
            data = remote_read(route, {"op": "image", "record_id": key[len(prefix):], "provider": request["remote"].get("provider", "claude"),
                                       "item": request.get("item"), "block": request.get("block"), "variant": variant}, 25)
            if data.get("image_error") or not isinstance(data.get("data"), str): raise BridgeError(data.get("image_error") or "远端图片读取失败")
            return {k: data.get(k) for k in ("mime", "data", "bytes")}
        entry = next((x for x in transcript_catalog() if x["id"] == request.get("record_id")), None)
        if not entry: raise BridgeError("历史记录已不存在，请刷新列表")
        return transcript_image(entry, request.get("item"), request.get("block"), variant)
    else: raise BridgeError("Invalid image kind")
    path, mime = cached_picture(sha, ext, variant)
    if not path: raise BridgeError("这张图片在电脑上已经清理掉了")
    return image_payload(path.read_bytes(), mime, variant)


def remote_transcript_image(request):
    entry = next((x for x in catalog_for_history(request["record_id"], request.get("provider", "claude")) if x["id"] == request["record_id"]), None)
    if not entry: raise BridgeError("历史记录已不存在")
    return transcript_image(entry, request.get("item"), request.get("block"), request.get("variant", "thumb"))


def prune_uploads(now=None):
    """Opportunistic cleanup: day folders older than UPLOAD_KEEP_DAYS, only files the phone writes."""
    root = uploads_root()
    if root.is_symlink() or not root.is_dir(): return
    cutoff = time.strftime("%Y-%m-%d", time.gmtime((now or time.time()) - UPLOAD_KEEP_DAYS * 86400))
    for day in root.iterdir():
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day.name) or day.name >= cutoff or day.is_symlink() or not day.is_dir(): continue
        for item in day.iterdir():
            if re.fullmatch(r"[a-f0-9]{64}(\.thumb)?\.(jpg|png)(\.[\w-]+\.tmp)?|\.[a-f0-9]{32}\.part", item.name) and not item.is_symlink() and item.is_file():
                item.unlink()
            elif re.fullmatch(r"[a-f0-9]{16}", item.name) and not item.is_symlink() and item.is_dir():
                # A file's folder (see Files): everything in it was written by the phone or by stage_file.
                for doc in item.iterdir():
                    if not doc.is_symlink() and doc.is_file(): doc.unlink()
                try: item.rmdir()
                except OSError: pass
        try: day.rmdir()
        except OSError: pass


# ─── Files ──────────────────────────────────────────────────────────────────
# Any other file (PDF, logs, archives, code…) goes up over SFTP, streamed and hashed on the phone,
# to ~/.herdr-pocket/uploads/<day>/<first 16 hex of sha256>/<original name>, so the agent sees the
# real name. The phone sanitizes the name; the bridge checks it again (one path segment, no
# leading dot, no control/format characters, ≤ 180 bytes) and re-hashes the file before use.
# A local pane gets "[文件] <absolute path>". For a ch-cli route the file is copied to the other
# computer through the same SSH route remote history uses, into that user's same uploads folder
# (stage_file, run by the phone before the prompt), and the prompt names the remote path after a
# remote hash check. Nothing else on either computer is written.
FILE_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})/([a-f0-9]{16})/([^/]+)")
FILE_LIMIT = 25_000_000
FILE_MAX = 4
# The phone gives up on one bridge call after 35 s; leave room for the pane lookup.
REMOTE_FILE_TIMEOUT = 25
# Reads a length-prefixed program from stdin; the rest of stdin is the file's bytes.
REMOTE_FILE_COMMAND = "python3 -c 'import sys;b=sys.stdin.buffer;exec(b.read(int(b.readline())))'"
SAFE_SSH = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no",
            "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=8"]


def file_name_ok(name):
    import unicodedata
    if not isinstance(name, str) or not 1 <= len(name.encode("utf-8", "surrogatepass")) <= 180: return False
    if name != name.strip() or name.startswith(".") or "/" in name or "\\" in name: return False
    return not any(unicodedata.category(c) in ("Cc", "Cf", "Cs", "Co", "Zl", "Zp") for c in name)


def file_ref(name, sha=None):
    """Validated (match, sha) for '<day>/<prefix>/<name>'; the sha must carry the folder's prefix."""
    match = FILE_NAME.fullmatch(name) if isinstance(name, str) else None
    if not match or not file_name_ok(match.group(3)): raise BridgeError("Invalid file name")
    if sha is not None and (not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{64}", sha) or not sha.startswith(match.group(2))):
        raise BridgeError("Invalid file hash")
    return match


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1 << 20): digest.update(chunk)
    return digest.hexdigest()


def uploaded_file(item):
    """The phone's upload named by {name, sha256}, re-hashed; refusals mean nothing was sent."""
    if not isinstance(item, dict): raise BridgeError("Invalid file")
    match = file_ref(item.get("name"), item.get("sha256"))
    label = match.group(3)[:60]
    path = owned_file(uploads_root() / match.group(0), uploads_root(), FILE_LIMIT)
    if not path: raise BridgeError("没发出去：文件「" + label + "」还没传到电脑上，删掉重新选一下")
    if file_sha256(path) != item["sha256"]:
        raise BridgeError("没发出去：电脑上的「" + label + "」和手机上的不一致，删掉重新选一下")
    return path, match


def upload_folder(parts, make):
    """~/.herdr-pocket/uploads/<parts…>, each a real folder of this user (created 0700); never follows links."""
    path = Path.home()
    for part in (".herdr-pocket", "uploads", *parts):
        path = path / part
        try: info = path.lstat()
        except FileNotFoundError:
            if not make: return None
            try: path.mkdir(mode=0o700)
            except FileExistsError: pass
            info = path.lstat()
        if not stat_module.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise BridgeError("上传目录异常：" + part + " 不是普通文件夹")
    return path


def file_check(request):
    """After an upload: does the file hash right? A wrong copy is removed so the phone can upload again."""
    match = file_ref(request.get("name"), request.get("sha256"))
    path = owned_file(uploads_root() / match.group(0), uploads_root(), FILE_LIMIT)
    if not path: return {"match": False, "missing": True}
    if file_sha256(path) == request["sha256"]: return {"match": True, "size": path.stat().st_size}
    path.unlink()
    return {"match": False}


def file_info(request):
    """Size of each named upload on this computer, or that it is gone (cleaned up)."""
    names = request.get("names")
    if not isinstance(names, list) or len(names) > 60: raise BridgeError("Invalid file list")
    found = {}
    for name in names:
        try: match = file_ref(name)
        except BridgeError: continue
        path = owned_file(uploads_root() / match.group(0), uploads_root(), FILE_LIMIT)
        found[name] = {"size": path.stat().st_size} if path else {"gone": True}
    return {"files": found}


# ─── Read-only file viewer ───────────────────────────────────────────────────
# Tapping 「查看文件内容」 on a path in a message reads that one text file, only then, never
# ahead of time. Only files inside the home folder or the conversation's project folder (after
# resolving symlinks), never key/credential/.env-style files, devices or pipes; at most
# VIEW_LIMIT bytes travel. A ch route reads on the other computer through the same stored,
# hash-checked adapter with the same rules there. See SECURITY.md.
VIEW_LIMIT = 512 * 1024
VIEW_SECRET_DIRS = {".ssh", ".gnupg", ".aws", ".password-store", ".kube", ".docker"}
VIEW_SECRET_PAIRS = ((".config", "gh"), (".local/share", "keyrings"))
VIEW_SECRET_NAME = re.compile(r"(?i)^(?:\.env.*|.*id_(?:rsa|dsa|ecdsa|ed25519).*|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk)"
                              r"|.*keystore.*|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|\.?credentials(?:\..*)?)$")


def view_secret(path):
    """Key, credential and .env-style locations, anywhere in the path."""
    parts = Path(path).parts
    if any(p in VIEW_SECRET_DIRS for p in parts): return True
    text = "/" + "/".join(parts[1:] if parts and parts[0] == "/" else parts) + "/"
    if any("/" + a + "/" + b + "/" in text for a, b in VIEW_SECRET_PAIRS): return True
    name, parent = parts[-1] if parts else "", parts[-2] if len(parts) > 1 else ""
    # Provider sign-in and config files (config may carry API keys in env blocks).
    low = name.lower()
    if parent == ".codex" and low.startswith(("auth", "config")): return True
    if parent == ".claude" and (low.startswith(".credentials") or low.startswith("settings")): return True
    if low == ".claude.json" or low.startswith(".claude.json."): return True
    return bool(VIEW_SECRET_NAME.match(name))


def view_inside(path, roots):
    return any(path == r or path.startswith(r.rstrip(os.sep) + os.sep) for r in roots)


def view_file(raw, base=None, extra_roots=()):
    """One text file under the home folder or the project folder, read-only, at most VIEW_LIMIT bytes."""
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 4096 or "\0" in raw: raise BridgeError("路径无效")
    home = os.path.realpath(str(Path.home()))
    roots = [home] + [os.path.realpath(r) for r in extra_roots if isinstance(r, str) and os.path.isabs(r)]
    roots = [r for r in dict.fromkeys(roots) if r != os.sep]
    if not roots: raise BridgeError("找不到可以查看的目录")
    path = raw.strip()
    if path.startswith("file://"): path = path[7:]
    if path == "~" or path.startswith("~/"): path = str(Path.home()) + path[1:]
    if not os.path.isabs(path):
        start = base if isinstance(base, str) and os.path.isabs(base) else str(Path.home())
        path = os.path.join(start, path)
    lexical = os.path.normpath(path)
    secret = "这是密钥、凭据或 .env 一类的敏感文件，不在手机上显示"
    if view_secret(lexical): raise BridgeError(secret)
    real = os.path.realpath(lexical)
    if not view_inside(real, roots):
        raise BridgeError("这个链接指向项目和主目录之外，不读取" if view_inside(lexical, roots) else "只能查看项目目录或主目录里的文件")
    if view_secret(real): raise BridgeError(secret)
    try: info = os.stat(real)
    except FileNotFoundError: raise BridgeError("文件不存在：" + os.path.basename(lexical)) from None
    except OSError as exc: raise BridgeError("读不到这个文件") from exc
    if stat_module.S_ISDIR(info.st_mode): raise BridgeError("这是文件夹，不是文件")
    if not stat_module.S_ISREG(info.st_mode): raise BridgeError("这不是普通文件（设备、管道或套接字），不读取")
    try: fd = os.open(real, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0))
    except PermissionError: raise BridgeError("没有权限读取这个文件") from None
    except OSError as exc: raise BridgeError("读不到这个文件") from exc
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat_module.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise BridgeError("文件刚刚变了，请重试")
        data = stream.read(VIEW_LIMIT)
    size, truncated = opened.st_size, opened.st_size > len(data)
    result = {"path": real, "name": os.path.basename(real), "size": size, "shown": len(data), "truncated": truncated, "mtime": opened.st_mtime}
    head = data[:8192]
    text = data.decode("utf-8", "replace")
    if truncated: text = text.rstrip("�")
    odd = sum(1 for c in text[:20000] if c == "�" or (ord(c) < 32 and c not in "\t\n\r\f\b\x1b"))
    if b"\0" in head or odd > max(8, len(text[:20000]) // 50):
        result.update(binary=True); return result
    result.update(binary=False, text=text)
    return result


def view_request(request):
    """fileView: this computer, or the other computer of a ch route (same rules there)."""
    path = request.get("path"); base = request.get("cwd")
    if base is not None and (not isinstance(base, str) or len(base) > 4096): raise BridgeError("Invalid cwd")
    provider = request.get("provider", "claude")
    if provider not in ("claude", "codex"): raise BridgeError("Invalid provider")
    record = request.get("record_id")
    if request.get("remote") is not None:
        context = request["remote"]; route = route_for_context(context); prefix = "remote:" + route["key"] + ":"
        data = {"op": "fileView", "path": path, "cwd": base, "workspace": route["workspace"], "provider": context.get("provider", provider)}
        if isinstance(record, str) and record.startswith(prefix) and re.fullmatch(r"[a-f0-9]{64}", record[len(prefix):]): data["record_id"] = record[len(prefix):]
        return remote_read(route, data, 20)
    return view_file(path, base, view_roots(record, provider))


def view_roots(record, provider, workspace=None):
    """The conversation's project folder (from its transcript), next to the home folder."""
    roots = [str(Path(workspace).expanduser())] if isinstance(workspace, str) else []
    if isinstance(record, str) and re.fullmatch(r"[a-f0-9]{64}", record):
        try: entry = next((x for x in catalog_for_history(record, provider) if x["id"] == record), None)
        except OSError: entry = None
        if entry and isinstance(entry.get("cwd"), str): roots.append(entry["cwd"])
    return roots


def pane_place(request, prefix, agent):
    """'local' or the ch route; refuses panes whose files would mean nothing to the agent."""
    probe = probe_pane(agent, prefix, agent.get("agent") or "")
    if not probe["ok"]: raise BridgeError("没发出去：看不清这个窗格运行在哪台电脑上，刷新后再试")
    if probe["route"]: return probe["route"]
    if probe["remote"] or request.get("remote"):
        raise BridgeError("没发出去：这个窗格连着别的电脑，又不是 ch 路由，文件传不过去")
    return "local"


def stage_file(request, prefix, agent):
    """Before a prompt: make one uploaded file reachable for the pane's agent. Idempotent, no agent input."""
    path, match = uploaded_file(request)
    place = pane_place(request, prefix, agent)
    if place == "local": return {"remote": False, "path": str(path)}
    data = remote_files(place, {"op": "put", "name": match.group(0), "sha256": request["sha256"], "size": path.stat().st_size}, path)
    return {"remote": True, "path": data["path"]}


def prompt_files(files, request, prefix, agent):
    if not isinstance(files, list) or not 1 <= len(files) <= FILE_MAX:
        raise BridgeError("一条消息最多带 4 个文件")
    try: prune_uploads()
    except OSError: pass
    checked = [uploaded_file(item) for item in files]
    place = pane_place(request, prefix, agent)
    if place == "local": return [("file", str(path)) for path, _ in checked]
    data = remote_files(place, {"op": "check", "items": [{"name": m.group(0), "sha256": item["sha256"]} for (_, m), item in zip(checked, files)]})
    if not isinstance(data.get("paths"), list) or len(data["paths"]) != len(files):
        raise BridgeError("没发出去：文件还没传到远端电脑，再发一次试试")
    return [("file", p) for p in data["paths"]]


def remote_files(route, params, path=None):
    """Runs remote_files_main on the other computer over the ch route; the file's bytes follow on stdin."""
    source = Path(__file__).read_text().rsplit('\nif __name__ == "__main__":', 1)[0]
    code = (source + "\nremote_files_main(" + repr(json.dumps(params)) + ")\n").encode()
    payload = str(len(code)).encode() + b"\n" + code + (path.read_bytes() if path else b"")
    try:
        result = subprocess.run([*SAFE_SSH, *route_ssh_options(route), REMOTE_FILE_COMMAND], input=payload, capture_output=True, timeout=REMOTE_FILE_TIMEOUT)
    except subprocess.TimeoutExpired as exc: raise BridgeError("没发出去：文件传到远端电脑超时，网络慢或文件太大") from exc
    except OSError as exc: raise BridgeError("没发出去：无法启动 SSH 连接远端电脑") from exc
    if result.returncode: raise BridgeError("没发出去：连不上远端电脑（SSH 认证、网络或 Python 不可用）")
    try: data = json.loads(result.stdout[:100_000])
    except ValueError as exc: raise BridgeError("没发出去：远端电脑返回格式异常") from exc
    if not isinstance(data, dict): raise BridgeError("没发出去：远端电脑返回格式异常")
    if data.get("missing"): raise BridgeError("没发出去：文件「" + str(data["missing"])[:60] + "」还没传到远端电脑，再发一次试试")
    if data.get("error"): raise BridgeError("没发出去：" + str(data["error"])[:200])
    return data


# Runs on the other computer (sent through stdin by remote_files): writes only inside that user's
# ~/.herdr-pocket/uploads/<day>/<prefix>/, never replaces a different file, never follows links.
def remote_files_main(raw):
    os.umask(0o077)
    try: result = remote_files_op(json.loads(raw), sys.stdin.buffer)
    except BridgeError as exc: result = {"error": str(exc)[:200]}
    except OSError as exc: result = {"error": "远端写入失败：" + str(exc.strerror or exc)[:80]}
    print(json.dumps(result, ensure_ascii=False), flush=True)


def remote_files_op(params, stream):
    try: prune_uploads()
    except OSError: pass
    if params.get("op") == "check":
        paths = []
        for item in params.get("items", [])[:FILE_MAX]:
            match = file_ref(item.get("name"), item.get("sha256"))
            path = owned_file(uploads_root() / match.group(0), uploads_root(), FILE_LIMIT) if upload_folder(match.groups()[:2], False) else None
            if not path or file_sha256(path) != item["sha256"]: return {"missing": match.group(3)}
            paths.append(str(path))
        return {"paths": paths}
    if params.get("op") != "put": raise BridgeError("unknown file op")
    match = file_ref(params.get("name"), params.get("sha256")); size = params.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= FILE_LIMIT: raise BridgeError("文件大小不对")
    folder = upload_folder(match.groups()[:2], True)
    target = folder / match.group(3)
    temp = folder.parent / ("." + os.urandom(16).hex() + ".part")
    digest, total = hashlib.sha256(), 0
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "wb") as out:
            while chunk := stream.read(1 << 16):
                total += len(chunk)
                if total > size: raise BridgeError("远端收到的文件比预期大")
                digest.update(chunk); out.write(chunk)
        if total != size or digest.hexdigest() != params["sha256"]: raise BridgeError("远端收到的文件不完整")
        try: os.link(temp, target)  # atomic and never replaces an existing name
        except FileExistsError: pass
        except OSError:
            if not os.path.lexists(target): os.rename(temp, target)
        same = owned_file(target, uploads_root(), FILE_LIMIT)
        if not same or file_sha256(same) != params["sha256"]: raise BridgeError("远端已有同名的不同文件，没有覆盖")
    finally:
        try: temp.unlink()
        except FileNotFoundError: pass
    return {"path": str(target)}


# ─── New agent sessions ───────────────────────────────────────────────────────
# Starting an agent from the phone. The phone only picks a kind from a fixed list, a
# directory and where to open it; every command line is chosen here. Herdr creates the
# tab (or workspace) in that directory without stealing focus; `herdr agent start`
# launches the canonical codex/claude executable, and for ch the fixed text `ch new` is
# typed into the brand-new shell pane. Nothing the phone sends is ever run as a command.
CREATE_KINDS = ("codex", "claude", "ch")
CREATE_KEYS = {"v", "op", "session", "id", "kind", "cwd", "workspace"}
CREATE_BUDGET = 26.0   # seconds for one create; the app waits 35 s for any request
CH_NEW = "ch new"      # ch-cli: new Claude for the shell's current directory (default account)
# Herdr refuses these before typing anything into the pane.
CREATE_PRE_START = {"agent_pane_unavailable", "agent_pane_not_found", "agent_name_taken", "invalid_agent",
                    "invalid_agent_name", "invalid_agent_argument", "invalid_agent_timeout", "pane_not_found"}


def find_executable(name):
    """Best-effort: SSH exec shells often miss user PATH entries such as ~/.local/bin or nvm."""
    found = shutil.which(name)
    if found: return found
    home = Path.home()
    folders = [home / ".local/bin", home / "bin", home / ".cargo/bin", home / ".npm-global/bin", home / ".bun/bin",
               home / ".volta/bin", home / ".deno/bin", Path("/usr/local/bin"), Path("/opt/homebrew/bin")]
    folders += sorted((home / ".nvm/versions/node").glob("*/bin"), reverse=True)
    for folder in folders:
        path = folder / name
        if path.is_file() and os.access(path, os.X_OK): return str(path)
    return None


def create_workspaces(prefix):
    """Workspaces with the directories their panes sit in (shell cwd, most used first)."""
    result = []
    for workspace in call(prefix + ["workspace", "list"]).get("workspaces", []):
        wid = workspace.get("workspace_id")
        if not isinstance(wid, str) or not re.fullmatch(r"w[A-Za-z0-9]+", wid): continue
        dirs = {}
        for pane in call(prefix + ["pane", "list", "--workspace", wid]).get("panes", []):
            cwd = pane.get("cwd")
            if not isinstance(cwd, str) or not cwd.startswith("/"): continue
            entry = dirs.setdefault(cwd, {"panes": 0, "agents": 0})
            entry["panes"] += 1
            if pane.get("agent"): entry["agents"] += 1
        ordered = sorted(dirs.items(), key=lambda x: (-x[1]["agents"], -x[1]["panes"]))
        result.append({"workspace_id": wid, "label": str(workspace.get("label") or ""), "focused": bool(workspace.get("focused")),
                       "dirs": [{"path": k, **v} for k, v in ordered]})
    return result


def suggestable_dir(path):
    """Directories worth offering: exist, not temp or hidden-tool folders."""
    try: p = Path(path)
    except TypeError: return False
    if not p.is_absolute(): return False
    home = Path.home()
    inside = p.is_relative_to(home)
    if any(part.startswith(".") for part in (p.relative_to(home).parts if inside else p.parts[1:])): return False
    if not inside and (p.parts[1:2] in (("tmp",), ("proc",), ("sys",), ("dev",)) or str(p).startswith("/var/tmp")): return False
    try: return p.is_dir()
    except OSError: return False


def history_dirs(limit=12):
    seen, found = set(), []
    for record in transcript_catalog():
        cwd = record.get("cwd")
        if not isinstance(cwd, str) or cwd in seen: continue
        seen.add(cwd)
        if suggestable_dir(cwd): found.append({"path": cwd, "modified": record.get("modified"), "provider": record.get("provider")})
        if len(found) >= limit: break
    return found


def create_info(prefix):
    workspaces = create_workspaces(prefix)
    dirs, seen = [], set()
    for workspace in workspaces:
        for d in workspace["dirs"]:
            # A pane is using it right now, so it is offered even outside $HOME (but must still exist).
            if os.path.realpath(d["path"]) in seen or not Path(d["path"]).is_dir(): continue
            seen.add(os.path.realpath(d["path"]))
            dirs.append({"path": d["path"], "source": "pane", "agents": d["agents"], "workspace_id": workspace["workspace_id"]})
    try: recent = history_dirs()
    except OSError: recent = []
    for d in recent:
        if os.path.realpath(d["path"]) in seen: continue
        seen.add(os.path.realpath(d["path"]))
        dirs.append({"path": d["path"], "source": "history", "modified": d["modified"]})
    kinds = [{"kind": k, "found": bool(find_executable(k))} for k in CREATE_KINDS]
    return {"kinds": kinds, "workspaces": workspaces, "dirs": dirs[:24], "home": str(Path.home())}


def create_dir(raw, known):
    """A real directory: under $HOME, or one a pane or recent history already uses. No `..`, no tricks."""
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in raw):
        raise BridgeError("没创建：目录路径不对")
    text = raw.strip()
    home = Path.home()
    if text == "~" or text.startswith("~/"): text = str(home) + text[1:]
    path = Path(text)
    if not path.is_absolute(): raise BridgeError("没创建：目录要写完整路径（以 / 或 ~/ 开头）")
    if ".." in path.parts: raise BridgeError("没创建：目录里不能有 ..")
    try: resolved = path.resolve(strict=True)
    except (OSError, RuntimeError): raise BridgeError("没创建：这个目录不存在") from None
    if not resolved.is_dir(): raise BridgeError("没创建：这不是一个目录")
    home = home.resolve()
    if str(resolved) in known() or (resolved.is_relative_to(home) and not any(p.startswith(".") for p in resolved.relative_to(home).parts)):
        return str(resolved)
    raise BridgeError("没创建：只能用家目录下的目录，或已经有窗格在用的目录")


def receipt_open(state_dir, req_id, digest, unknown="上次新建的结果未知：先刷新列表看看，别直接重试"):
    """Same receipts as other mutations: written before anything happens, never executed twice."""
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(state_dir / "receipts.sqlite", timeout=5)
    db.execute("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT, result TEXT)")
    db.execute("BEGIN IMMEDIATE")
    previous = db.execute("SELECT digest, result FROM receipts WHERE id=?", (req_id,)).fetchone()
    if previous:
        db.rollback(); db.close()
        if previous[0] != digest: raise BridgeError("Request id reused with different content")
        if previous[1] is None: raise BridgeError(unknown)
        return None, json.loads(previous[1])
    db.execute("INSERT INTO receipts VALUES (?, ?, NULL)", (req_id, digest))
    db.commit()
    return db, None


def receipt_save(db, req_id, result):
    db.execute("UPDATE receipts SET result=? WHERE id=?", (json.dumps(result), req_id))
    db.commit()


def pane_agent_state(pane, kind):
    """ready / blocked / starting from what Herdr sees in the pane now."""
    expected = "claude" if kind == "ch" else kind
    if pane.get("agent") != expected: return None
    status = pane.get("agent_status")
    return "ready" if status in ("idle", "done") else "blocked" if status == "blocked" else "starting"


def start_in_pane(prefix, pane_id, kind, name, deadline):
    tries = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining < 5: return {"state": "starting"}
        wait_ms = int(min(remaining - 2, 22) * 1000)
        try:
            call(prefix + ["agent", "start", name, "--kind", kind, "--pane", pane_id, "--timeout", str(wait_ms)],
                 timeout=wait_ms / 1000 + 3)
            return {"state": "ready", "agent_name": name}
        except HerdrRejected as exc:
            # A fresh shell may still be starting up; Herdr typed nothing, so trying again is safe.
            if exc.code == "agent_pane_unavailable" and tries < 6:
                tries += 1; time.sleep(0.8); continue
            if exc.code == "agent_not_ready": return {"state": "blocked", "agent_name": name}
            if "timeout" in exc.code: return {"state": "starting", "agent_name": name}
            return {"state": "failed", "code": exc.code, "detail": exc.detail[:300], "typed": exc.code not in CREATE_PRE_START}
        except BridgeError:
            return {"state": "starting", "agent_name": name}


def start_ch(prefix, pane_id, deadline):
    try:
        call(prefix + ["pane", "run", pane_id, CH_NEW])
    except HerdrRejected as exc:
        return {"state": "failed", "code": exc.code, "detail": exc.detail[:300], "typed": exc.code not in CREATE_PRE_START}
    except BridgeError:
        return {"state": "starting"}
    seen = None
    while time.monotonic() < deadline - 1:
        time.sleep(1)
        try: pane = call(prefix + ["pane", "get", pane_id]).get("pane") or {}
        except BridgeError: continue
        seen = pane_agent_state(pane, "ch") or seen
        if seen in ("ready", "blocked"): break
    return {"state": seen or "starting", "detected": bool(seen)}


def create_agent(request, prefix, state_dir):
    started_at = time.monotonic()
    deadline = started_at + CREATE_BUDGET
    extra = set(request) - CREATE_KEYS
    if extra: raise BridgeError("没创建：请求里有不认识的字段")
    req_id = request.get("id", "")
    if not isinstance(req_id, str) or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", req_id):
        raise BridgeError("Mutation requires a UUID request id")
    kind = request.get("kind")
    if kind not in CREATE_KINDS: raise BridgeError("没创建：不支持的 Agent 类型")
    place = request.get("workspace")
    if not isinstance(place, str) or not (place == "new" or re.fullmatch(r"w[A-Za-z0-9]{1,16}", place)):
        raise BridgeError("没创建：位置不对")
    if not find_executable(kind):
        raise BridgeError("没创建：这台电脑上没找到 " + kind + " 命令")
    workspaces = create_workspaces(prefix)
    if place != "new" and not any(w["workspace_id"] == place for w in workspaces):
        raise BridgeError("没创建：那个工作区已经不在了，刷新一下")
    pane_dirs = {d["path"] for w in workspaces for d in w["dirs"]}
    known = lambda: pane_dirs | {d["path"] for d in history_dirs(40)}
    cwd = create_dir(request.get("cwd"), known)
    digest = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    db, previous = receipt_open(state_dir, req_id, digest)
    if previous is not None: return previous
    try:
        args = (["workspace", "create"] if place == "new" else ["tab", "create", "--workspace", place]) + ["--cwd", cwd, "--no-focus"]
        try:
            made = call(prefix + args)
        except HerdrRejected as exc:
            receipt_save(db, req_id, {"created": False, "code": exc.code})
            raise BridgeError("没创建：Herdr 没接受（" + exc.code + "）") from exc
        except BridgeError as exc:
            raise BridgeError("新建结果未知：Herdr 没及时回应。先刷新列表看看，别直接重试") from exc
        root = made.get("root_pane") or {}
        pane_id = root.get("pane_id")
        if not isinstance(pane_id, str) or not re.fullmatch(r"w[A-Za-z0-9]+:p[A-Za-z0-9]+", pane_id):
            raise BridgeError("新建结果未知：Herdr 没返回新窗格。先刷新列表看看，别直接重试")
        result = {"created": True, "kind": kind, "cwd": cwd, "pane_id": pane_id,
                  "tab_id": (made.get("tab") or {}).get("tab_id") or root.get("tab_id"),
                  "workspace_id": (made.get("workspace") or {}).get("workspace_id") or root.get("workspace_id") or place,
                  "new_workspace": place == "new", "state": "starting"}
        # Saved before starting: even if this process dies now, a retry reports the pane, not a new one.
        receipt_save(db, req_id, result)
        name = "pocket-" + req_id[:8]
        outcome = start_ch(prefix, pane_id, deadline) if kind == "ch" else start_in_pane(prefix, pane_id, kind, name, deadline)
        if outcome["state"] != "ready":
            # One last look: what is actually in the pane now.
            try:
                now = pane_agent_state(call(prefix + ["pane", "get", pane_id]).get("pane") or {}, kind)
                if now: outcome = dict(outcome, state=now, detected=True)
            except BridgeError: pass
        result.update(outcome)
        receipt_save(db, req_id, result)
        return result
    finally:
        db.close()


# ─── Slash commands ─────────────────────────────────────────────────────────
# The phone ships the built-in command lists; this adds what the user installed: Claude custom
# commands and skills (user + project, from the pane's working directory upwards) and Codex custom
# prompts. Names only — file contents are never read or returned.
COMMAND_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
COMMANDS_MAX = 200


def project_dirs(cwd):
    """The pane's directory and its parents, stopping above the home directory or after 8 levels."""
    try: path = Path(cwd).resolve() if isinstance(cwd, str) and cwd.startswith("/") else None
    except (OSError, RuntimeError): path = None
    if path is None: return []
    home, found = Path.home().resolve(), []
    while len(found) < 8:
        if path == home or path == path.parent: break
        found.append(path)
        path = path.parent
    return found


def command_files(folder, prefix=""):
    """`*.md` under a commands folder; one level of sub-folders becomes `dir:name`, like Claude."""
    names = []
    try: entries = sorted(folder.iterdir(), key=lambda p: p.name)
    except OSError: return names
    for entry in entries[:400]:
        try:
            if entry.is_file() and entry.suffix == ".md" and COMMAND_NAME.fullmatch(entry.stem):
                names.append(prefix + entry.stem)
            elif entry.is_dir() and not prefix and COMMAND_NAME.fullmatch(entry.name):
                names.extend(command_files(entry, entry.name + ":"))
        except OSError: continue
    return names


def skill_names(folder):
    names = []
    try: entries = sorted(folder.iterdir(), key=lambda p: p.name)
    except OSError: return names
    for entry in entries[:400]:
        try:
            if entry.is_dir() and COMMAND_NAME.fullmatch(entry.name) and (entry / "SKILL.md").is_file(): names.append(entry.name)
        except OSError: continue
    return names


def custom_commands(agent):
    provider = agent.get("agent")
    home, seen, found = Path.home(), set(), []
    def add(name, kind, scope):
        if name in seen or len(found) >= COMMANDS_MAX: return
        seen.add(name); found.append({"name": name, "kind": kind, "scope": scope})
    if provider == "claude":
        for directory in project_dirs(agent.get("foreground_cwd") or agent.get("cwd")):
            for name in command_files(directory / ".claude/commands"): add(name, "command", "project")
            for name in skill_names(directory / ".claude/skills"): add(name, "skill", "project")
        for name in command_files(home / ".claude/commands"): add(name, "command", "user")
        for name in skill_names(home / ".claude/skills"): add(name, "skill", "user")
    elif provider == "codex":
        codex_home = Path(os.environ.get("CODEX_HOME") or home / ".codex")
        for name in command_files(codex_home / "prompts", ""):
            if ":" not in name: add("prompts:" + name, "prompt", "user")
    return {"provider": provider or "", "commands": found}


# ─── Closing sessions ─────────────────────────────────────────────────────────
# Ending an agent or closing its pane from the phone. Both end running processes, so the
# phone names the exact pane and the identity it showed the person; the bridge re-checks
# that against the live pane, writes a receipt before acting and never runs anything twice.
#  · exitAgent (in mutate): the agent quits its own way; the bridge picks the command
#    (Claude Code `/exit`, Codex `/quit`), only while the agent is idle. The pane stays a shell.
#  · closePane: `herdr pane close <pane>`, nothing else. The pane's processes end with it.
# For a ch-cli attach the pane only holds the SSH attach: closing it detaches and the remote
# tmux session keeps running (it can be resumed with `ch resume`); exiting the agent ends it.
EXIT_COMMANDS = {"claude": "/exit", "codex": "/quit"}
CLOSE_KEYS = {"v", "op", "session", "id", "target", "identity"}
PANE_ID = re.compile(r"w[A-Za-z0-9]+:p[A-Za-z0-9]+")
HIDDEN_ID = re.compile(r"[a-f0-9]{64}|remote:[a-f0-9]{24}:[a-f0-9]{64}")
HIDDEN_MAX = 2000


def close_target(request, prefix):
    """The live pane and its agent (or None), only if it is still what the phone showed."""
    target, expected = request.get("target"), request.get("identity")
    if not isinstance(target, str) or not PANE_ID.fullmatch(target):
        raise BridgeError("没关：窗格编号不对")
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise BridgeError("没关：缺少窗格身份")
    agent = next((a for a in agents(prefix) if a.get("pane_id") == target), None)
    try: live = call(prefix + ["pane", "get", target])
    except HerdrRejected as exc:
        if exc.code == "pane_not_found": raise BridgeError("没关：这个窗格已经不在了，刷新一下") from exc
        raise
    pane = live.get("pane", live)
    if pane.get("pane_id") != target: raise BridgeError("没关：这个窗格已经不在了，刷新一下")
    if agent:
        if agent["identity"] != expected: raise BridgeError("没关：这个窗格里的 Agent 变了，刷新列表再看")
    elif pane.get("agent") or not pane.get("terminal_id") or identity(pane) != expected:
        raise BridgeError("没关：这个窗格变了，刷新列表再看")
    return pane, agent


def close_info(request, prefix):
    """Read-only facts for the confirmation sheet: where the pane is and what closing it means."""
    pane, agent = close_target(request, prefix)
    wid, tid = pane.get("workspace_id"), pane.get("tab_id")
    workspace = next((w for w in call(prefix + ["workspace", "list"]).get("workspaces", []) if w.get("workspace_id") == wid), {})
    tab = next((t for t in call(prefix + ["tab", "list", "--workspace", wid]).get("tabs", []) if t.get("tab_id") == tid), {}) if wid else {}
    route = probe_pane(agent, prefix, agent["agent"])["route"] if agent else None
    provider = (agent or {}).get("agent")
    return {"pane_id": pane["pane_id"], "agent": provider, "agent_status": (agent or {}).get("agent_status"),
            "focused": bool(pane.get("focused")), "workspace_label": str(workspace.get("label") or ""),
            "tab_label": str(tab.get("label") or ""), "tab_panes": tab.get("pane_count"),
            "workspace_panes": workspace.get("pane_count"), "exit_command": EXIT_COMMANDS.get(provider),
            "ch": bool(route), "ch_session": Path(route["workspace"]).name if route else None}


def close_pane(request, prefix, state_dir):
    extra = set(request) - CLOSE_KEYS
    if extra: raise BridgeError("没关：请求里有不认识的字段")
    req_id = request.get("id", "")
    if not isinstance(req_id, str) or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", req_id):
        raise BridgeError("Mutation requires a UUID request id")
    digest = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    db, previous = receipt_open(state_dir, req_id, digest, "上次关闭的结果未知：先刷新列表看看，别直接重试")
    if previous is not None: return previous
    try:
        try:
            pane, agent = close_target(request, prefix)
        except BridgeError as exc:
            # Checked before anything was closed: record the refusal so this id can never act later.
            receipt_save(db, req_id, {"closed": False, "refused": str(exc)[:300]})
            raise
        target = pane["pane_id"]
        try:
            call(prefix + ["pane", "close", target])
        except HerdrRejected as exc:
            receipt_save(db, req_id, {"closed": False, "code": exc.code})
            if exc.code == "pane_not_found": raise BridgeError("没关：这个窗格已经不在了，刷新一下") from exc
            raise BridgeError("没关：Herdr 没接受（" + exc.code + "）") from exc
        except BridgeError as exc:
            raise BridgeError("关闭结果未知：Herdr 没及时回应。刷新列表看看，别直接重试") from exc
        result = {"closed": True, "pane_id": target, "agent": (agent or {}).get("agent"), "verified": False}
        receipt_save(db, req_id, result)
        try: call(prefix + ["pane", "get", target])
        except HerdrRejected as exc: result["verified"] = exc.code == "pane_not_found"
        except BridgeError: pass
        receipt_save(db, req_id, result)
        return result
    finally:
        db.close()


def hidden_path(state_dir):
    return state_dir / "hidden-records.json"


def hidden_records(request, state_dir):
    """History records the person removed from the app's list. Only IDs; transcripts are never touched."""
    path = hidden_path(state_dir)
    try:
        ids = json.loads(path.read_text()) if path.is_file() and not path.is_symlink() else []
        if not isinstance(ids, list): ids = []
    except (OSError, ValueError): ids = []
    ids = [x for x in ids if isinstance(x, str) and HIDDEN_ID.fullmatch(x)]
    add, remove = request.get("add", []), request.get("remove", [])
    if not add and not remove: return {"ids": ids}
    for value in (add, remove):
        if not isinstance(value, list) or len(value) > 200 or not all(isinstance(x, str) and HIDDEN_ID.fullmatch(x) for x in value):
            raise BridgeError("Invalid record ids")
    ids = [x for x in ids if x not in remove and x not in add] + [x for x in dict.fromkeys(add) if x not in remove]
    ids = ids[-HIDDEN_MAX:]
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = state_dir / ".hidden-records.tmp"
    temp.write_text(json.dumps(ids))
    os.chmod(temp, 0o600)
    os.replace(temp, path)
    return {"ids": ids}


def ssh_info():
    import getpass
    import socket
    return {"ssh_user": getpass.getuser(), "hostname": socket.gethostname()}



def handle(request, state_dir=None):
    if not isinstance(request, dict) or request.get("v") != 1:
        raise BridgeError("Expected protocol version 1")
    op = request.get("op")
    if op == "hello":
        return {"version": VERSION, "protocol": 1, "python": "%d.%d" % sys.version_info[:2]}
    if op == "doctor":
        return doctor()
    if op == "account":
        return ssh_info()
    if op == "image":
        try: prune_uploads()
        except OSError: pass
        return image_request(request)
    if op == "fileCheck": return file_check(request)
    if op == "glance": return glance(request)
    if op == "fileInfo": return file_info(request)
    if op == "fileView": return view_request(request)
    if op in ("catalog", "history"):
        if request.get("remote") is not None: return remote_history_request(request)
        catalog = transcript_catalog()
        if op == "history": return attach_kids(history_page(request, catalog), catalog, request)
        offset = request.get("offset", 0)
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0: raise BridgeError("Invalid catalog offset")
        query = request.get("query", "")
        if not isinstance(query, str) or len(query) > 200: raise BridgeError("Invalid search")
        if query: catalog = [x for x in catalog if query.lower() in (x["title"] + " " + x["cwd"] + " " + str(x["thread"])).lower()]
        thread = request.get("thread")
        if thread: catalog = [x for x in catalog if x["thread"] == thread]
        return {"records": [public_record(x) for x in catalog[offset:offset+100]], "total": len(catalog), "next": offset+100 if len(catalog)>offset+100 else None}
    if op == "sessions":
        return {"sessions": [{k: s.get(k) for k in ("name", "running", "default")} for s in sessions()]}
    if op in ("panes", "paneRead", "paneRun", "paneText", "paneKey"):
        prefix = select_session(request)
        if op == "panes": return {"panes": panes(prefix)}
        target = request.get("target")
        if not isinstance(target, str) or not re.fullmatch(r"w[A-Za-z0-9]+:p[A-Za-z0-9]+", target):
            raise BridgeError("Invalid pane target")
        live = call(prefix + ["pane", "get", target])
        pane = live.get("pane", live)
        if pane.get("pane_id") != target or not pane.get("terminal_id") or pane.get("agent") or identity(pane) != request.get("identity"):
            raise BridgeError("Pane changed or now contains an Agent; reload terminals")
        if op == "paneRead":
            return call(prefix + ["pane", "read", target, "--source", "recent-unwrapped", "--lines", "400"])
        return mutate(request, prefix, pane, state_dir or Path.home() / ".local/state/herdr-pocket")
    if op in ("createInfo", "create"):
        prefix = select_session(request)
        if op == "createInfo": return create_info(prefix)
        return create_agent(request, prefix, state_dir or Path.home() / ".local/state/herdr-pocket")
    if op == "hidden": return hidden_records(request, state_dir or Path.home() / ".local/state/herdr-pocket")
    if op in ("closeInfo", "closePane"):
        prefix = select_session(request)
        if op == "closeInfo": return close_info(request, prefix)
        return close_pane(request, prefix, state_dir or Path.home() / ".local/state/herdr-pocket")
    if op not in ("agents", "status", "read", "prompt", "key", "answer", "stageFile", "commands", "exitAgent"):
        raise BridgeError("Unknown operation")
    prefix = select_session(request)
    if op == "status":
        # Cheap poll: Herdr state only, no process walk or history resolution.
        fields = ("pane_id", "agent", "agent_status", "agent_session", "terminal_id", "terminal_title",
                  "terminal_title_stripped", "title", "cwd", "foreground_cwd", "workspace_id", "tab_id", "identity")
        return {"agents": [{k: a.get(k) for k in fields} for a in agents(prefix)]}
    if op == "agents" and request.get("target") is not None:
        return follow_pane(request, prefix)
    found = agents(prefix, include_history=op == "agents")
    if op == "agents":
        return {"agents": found}
    target = request.get("target")
    agent = next((a for a in found if a.get("pane_id") == target), None)
    if not agent or request.get("identity") != agent["identity"]:
        raise BridgeError("Agent changed or disappeared; reload the agent list")
    if op == "stageFile":
        return stage_file(request, prefix, agent)
    if op == "commands":
        return custom_commands(agent)
    if op == "read":
        # `menu: true` (after a slash command) parses a picker even when Herdr does not call it blocked.
        screen = with_menu(read_screen(prefix, agent, 160), agent, request.get("menu") is True)
        screen["modes"] = screen_modes(screen.get("text", ""), agent.get("agent"))
        return screen
    return mutate(request, prefix, agent, state_dir or Path.home() / ".local/state/herdr-pocket")


def main():
    # The app maps this stderr line to "Python 太旧" (ConnectErrors.kt); keep the wording.
    if sys.version_info < (3, 9):
        sys.exit("Herdr Pocket needs Python 3.9 or newer; this is %d.%d" % sys.version_info[:2])
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.readline(LIMIT + 1)
        if len(raw) > LIMIT:
            raise BridgeError("Request too large")
        response = {"ok": True, "data": handle(json.loads(raw))}
    except Exception as exc:
        response = {"ok": False, "error": str(exc)[:2000]}
    print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
