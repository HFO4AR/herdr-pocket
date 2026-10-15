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

VERSION = "0.5.0"
LIMIT = 65536


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


def call(args):
    binary = shutil.which("herdr") or str(Path.home() / ".local/bin/herdr")
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERDR_")}
    try:
        result = subprocess.run([binary, *args], capture_output=True, text=True,
                                timeout=20, env=env)
    except subprocess.TimeoutExpired as exc:
        raise BridgeError("Herdr timeout; mutation outcome may be unknown. Do not resend blindly.") from exc
    except OSError as exc:
        raise BridgeError("Herdr executable unavailable. Install Herdr for this SSH user.") from exc
    if result.returncode:
        raise herdr_error(result.stdout) or herdr_error(result.stderr) or BridgeError((result.stderr or result.stdout or "Herdr command failed")[:2000])
    # Herdr 0.8.x agent read emits plain text, while list/control emit JSON.
    command_args = args[2:] if args[:1] == ["--session"] else args
    if command_args[:2] in (["agent", "read"], ["pane", "read"]):
        return {"text": result.stdout}
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
            if not isinstance(text, str) or not text.strip() or len(text.encode()) > 16000 or "\x00" in text:
                raise BridgeError("Prompt must contain 1–16000 UTF-8 bytes without NUL")
            args = ["agent", "prompt", agent["pane_id"], text]
        elif op == "key":
            if key not in ("up", "down", "left", "right", "enter", "esc", "ctrl+c"):
                raise BridgeError("Unsupported key")
            args = ["agent", "send-keys", agent["pane_id"], key]
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
            value = answer_question(request, prefix, agent) if op == "answer" else call(prefix + args)
        except HerdrRejected as exc:
            if exc.code not in NOT_SENT: raise
            # Rejected before any input reached the pane: record why, and say it can be resent.
            db.execute("UPDATE receipts SET result=? WHERE id=?", (json.dumps({"sent": False, "rejected": exc.code}), req_id))
            db.commit()
            raise BridgeError(NOT_SENT[exc.code]) from exc
        result = {"sent": True, "receipt": req_id, "result": value}
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
    result=history_page(selected,catalog)
    result["active_status"]=active
    if current: result["active_record"]=public_record(current)
    result["active_changed"]=selected["record_id"]!=request["record_id"]
    return result

def remote_read(route, request, limit=None):
    # Code is sent through stdin, and the only remote entry points read the two
    # authorized history roots. No installer, provider credentials or shell input.
    source = Path(__file__).read_text().rsplit('\nif __name__ == "__main__":',1)[0]
    code = source + "\nrequest = json.loads(" + repr(json.dumps(request)) + ")\n"
    code += "op = request['op']\n"
    code += "if op == 'resolve': result = {'routes': remote_resolve(request.get('items', []))}\n"
    code += "elif op == 'history': result = remote_history_page(request)\n"
    code += "elif op == 'catalog': result = {'records': [public_record(x) for x in scoped_records(request.get('provider','claude'), request['workspace'], 100)]}\n"
    code += "else: result = {'error': 'unknown remote op'}\n"
    code += "encoded = json.dumps(result, ensure_ascii=False)\nprint(encoded if len(encoded.encode()) <= 2_000_000 else '{\"error\":\"history response exceeds 2 MB\"}')\n"
    args = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=8", *route["ssh"], "python3 -c 'import sys; exec(sys.stdin.read())'"]
    limit = limit or (25 if request["op"] == "history" else 15)
    remaining = limit if _remote_deadline is None else min(limit, _remote_deadline-time.monotonic())
    if remaining <= 0: raise BridgeError("远端历史读取达到本次时限，请刷新重试")
    try: result = subprocess.run(args, input=code, capture_output=True, text=True, timeout=remaining)
    except subprocess.TimeoutExpired as exc: raise BridgeError("远端电脑响应超时") from exc
    except OSError as exc: raise BridgeError("无法启动 SSH 连接远端电脑") from exc
    if result.returncode: raise BridgeError("连不上远端电脑：SSH 认证、网络或 Python 环境不可用")
    if len(result.stdout.encode()) > 2_000_000: raise BridgeError("远端历史响应过大")
    try: data = json.loads(result.stdout)
    except ValueError as exc: raise BridgeError("远端历史返回格式异常") from exc
    if not isinstance(data,dict) or data.get("error"): raise BridgeError("远端历史读取失败或响应超过 2 MB")
    return data


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


def route_for_context(context):
    if not isinstance(context,dict): raise BridgeError("Invalid remote history context")
    prefix = select_session(context)
    found = agents(prefix)
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
                text = text_content(value.get("content", []))
                # Codex appends machine-readable memory citations to replies; they are not for people.
                if value.get("role") == "assistant": text = re.sub(r"\s*<oai-mem-citation>.*?</oai-mem-citation>\s*", "\n", text, flags=re.S).strip()
                if value.get("role") != "user" or not text.startswith(("# AGENTS.md", "<environment_context>", "<INSTRUCTIONS>")):
                    add(value["role"], text, phase=value.get("phase") if isinstance(value.get("phase"), str) else "")
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
        if row.get("type") not in ("user", "assistant") or row.get("isMeta"): return []
        value = row.get("message", {}); content = value.get("content", "")
        if isinstance(content, str):
            if not content.startswith(("<local-command", "<command-name", "<system-reminder")): add(row["type"], content)
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict): continue
                if block.get("type") == "text": add(row["type"], block.get("text", ""))
                elif block.get("type") == "tool_use":
                    args = block.get("input", {}); text = args.get("command") if isinstance(args, dict) else None
                    add("tool", text or json.dumps(args, ensure_ascii=False, indent=2), block.get("name", "工具调用"), block.get("id", ""))
                elif block.get("type") == "tool_result":
                    add("result", text_content(block.get("content", "")), "执行失败" if block.get("is_error") else "执行结果", block.get("tool_use_id", ""))
                elif block.get("type") == "image": add(row["type"], "[图片附件 · 请在电脑查看]")
    return result


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


def with_menu(screen, agent):
    """Attach the parsed menu to a read while the agent waits on one."""
    if agent.get("agent_status") == "blocked":
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
        text = call(prefix + ["agent", "read", target, "--source", "recent-unwrapped", "--lines", "80"]).get("text", "")
        return parse_menu(text, agent.get("agent", ""))

    def press(name):
        if len(steps) >= ANSWER_KEYS_LIMIT * 2: raise BridgeError("按键太多，已停下")
        call(prefix + ["agent", "send-keys", target, name])
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


def ssh_info():
    import getpass
    import socket
    return {"ssh_user": getpass.getuser(), "hostname": socket.gethostname()}



def handle(request, state_dir=None):
    if not isinstance(request, dict) or request.get("v") != 1:
        raise BridgeError("Expected protocol version 1")
    op = request.get("op")
    if op == "hello":
        return {"version": VERSION, "protocol": 1}
    if op == "account":
        return ssh_info()
    if op in ("catalog", "history"):
        if request.get("remote") is not None: return remote_history_request(request)
        catalog = transcript_catalog()
        if op == "history": return history_page(request, catalog)
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
    if op not in ("agents", "status", "read", "prompt", "key", "answer"):
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
    if op == "read":
        return with_menu(call(prefix + ["agent", "read", target, "--source", "recent-unwrapped", "--lines", "160"]), agent)
    return mutate(request, prefix, agent, state_dir or Path.home() / ".local/state/herdr-pocket")


def main():
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
