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

VERSION = "0.4.0"
LIMIT = 65536


class BridgeError(Exception):
    pass


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
        raise BridgeError((result.stderr or result.stdout or "Herdr command failed")[:2000])
    # Herdr 0.8.x agent read emits plain text, while list/control emit JSON.
    if any(group in args and args[args.index(group) + 1] == "read" for group in ("agent", "pane")):
        return {"text": result.stdout}
    try:
        data = json.loads(result.stdout)
    except ValueError as exc:
        raise BridgeError("Herdr returned non-JSON output; check CLI compatibility.") from exc
    if data.get("error"):
        raise BridgeError(str(data["error"])[:2000])
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
    _remote_deadline = time.monotonic() + 22
    catalog = None
    for agent in result:
        if agent.get("agent") not in ("codex", "claude"): continue
        if catalog is None: catalog = transcript_catalog()
        agent["history_ref"] = resolve_agent_history(agent, prefix, catalog)
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
        value = call(prefix + args)
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
        paths = []
        for fd in list((root / "fd").iterdir())[:256]:
            try:
                target = fd.readlink()
                if target.suffix == ".jsonl": paths.append(target)
            except OSError: pass
        after = (root / "stat").read_text().rsplit(") ", 1)[1].split()[19]
        return {"argv": argv, "children": children, "paths": paths, "cwd": str((root / "cwd").readlink())} if before == after else None
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


def resolve_agent_history(agent, prefix, catalog):
    provider = agent["agent"]
    candidates = [x for x in catalog if x["provider"] == provider]
    reported = agent.get("agent_session") or {}
    value = reported.get("value")
    if value:
        # Herdr supports both session ids and transcript paths. Paths must already
        # be in the allow-listed catalog; no request path is ever opened here.
        matches = [x for x in candidates if x["thread"] == value or str(x["_path"]) == value]
        if matches: return {"status": "matched", "record_id": matches[0]["id"], "thread": matches[0]["thread"], "source": "herdr"}
        return {"status": "missing", "source": "herdr"}
    try: info = call(prefix + ["pane", "process-info", "--pane", agent["pane_id"]]).get("process_info", {})
    except BridgeError: return {"status": "unavailable"}
    processes = info.get("foreground_processes", [])
    ids, paths, seen = set(), set(), set()
    remote = False
    candidate_cwd = ""
    route = None
    queue = [(p.get("pid"), p.get("argv", [])) for p in processes]
    while queue and len(seen) < 64:
        pid, initial_argv = queue.pop(0)
        if not isinstance(pid, int) or pid in seen: continue
        seen.add(pid)
        snapshot = process_snapshot(pid)
        argv = snapshot["argv"] if snapshot else initial_argv
        remote = remote or bool(argv and Path(argv[0]).name in ("ssh", "mosh", "mosh-client"))
        route = route or ch_ssh_route(argv)
        if argv and Path(argv[0]).name in (provider,provider+".exe"):
            candidate_cwd = (snapshot or {}).get("cwd", candidate_cwd)
        ids.update(explicit_session_ids(argv, provider))
        if snapshot:
            # Only native provider processes may supply transcript FD matches.
            if argv and Path(argv[0]).name in (provider, provider + ".exe"):
                paths.update(snapshot["paths"])
            queue.extend((child, []) for child in snapshot["children"])
    matches = [x for x in candidates if x["thread"] in ids or x["_path"] in paths]
    if matches and len({x["thread"] for x in matches}) == 1:
        return {"status": "matched", "record_id": matches[0]["id"], "thread": matches[0]["thread"], "source": "process"}
    if route:
        context = {"session": prefix[1] if len(prefix)>1 else "default", "target": agent["pane_id"], "identity": agent.get("identity", identity(agent)), "provider":provider}
        try:
            records = remote_catalog(route, context)
            threads = {x["thread"] for x in records if x.get("route_match") and not x.get("parent") and x["provider"] == provider}
            if len(threads) == 1:
                record = next(x for x in records if x["thread"] in threads and not x.get("parent"))
                return {"status":"matched", "source":"ch-route", "record_id":record["id"], "thread":record["thread"], "record":record, "remote":context}
            return {"status":"remote_candidates" if records else "remote_missing", "remote":context, "candidates":records[:12]}
        except BridgeError as exc: return {"status":"remote_error", "reason":str(exc)}
    return {"status": "remote" if remote else "ambiguous" if len(matches)>1 else "missing" if ids else "unavailable", "query":candidate_cwd, "candidates":[public_record(x) for x in candidates if candidate_cwd and x["cwd"] == candidate_cwd and not x.get("parent")][:12]}


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


_remote_catalog_cache = {}
_remote_deadline = None


def remote_read(route, request):
    # Code is sent through stdin, and the only remote entry points read the two
    # authorized history roots. No installer, provider credentials or shell input.
    source = Path(__file__).read_text().rsplit('\nif __name__ == "__main__":',1)[0]
    code = source + "\nrequest = json.loads(" + repr(json.dumps(request)) + ")\n"
    code += "catalog = transcript_catalog(write_cache=False)\n"
    code += "result = history_page(request, catalog) if request['op'] == 'history' else {'records': [public_record(x) for x in catalog], 'home': str(Path.home())}\n"
    code += "encoded = json.dumps(result, ensure_ascii=False)\nprint(encoded if len(encoded.encode()) <= 2_000_000 else '{\"error\":\"history response exceeds 2 MB\"}')\n"
    args = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=8", *route["ssh"], "python3 -c 'import sys; exec(sys.stdin.read())'"]
    remaining = 15 if _remote_deadline is None else min(15, _remote_deadline-time.monotonic())
    if remaining <= 0: raise BridgeError("远端历史索引达到本次读取时限，请刷新重试")
    try: result = subprocess.run(args, input=code, capture_output=True, text=True, timeout=remaining)
    except (OSError, subprocess.TimeoutExpired) as exc: raise BridgeError("远端历史连接不可用或超时") from exc
    if result.returncode: raise BridgeError("远端历史读取失败：SSH 认证、连接或 Python 环境不可用")
    if len(result.stdout.encode()) > 2_000_000: raise BridgeError("远端历史索引过大")
    try: data = json.loads(result.stdout)
    except ValueError as exc: raise BridgeError("远端历史返回格式异常") from exc
    if not isinstance(data,dict) or data.get("error"): raise BridgeError("远端历史读取失败或响应超过 2 MB")
    return data


def wrap_remote_record(record, route, context):
    return dict(record, id="remote:"+route["key"]+":"+record["id"], remote=context)


def remote_catalog(route, context):
    key = json.dumps(route["ssh"])
    if key not in _remote_catalog_cache:
        try: _remote_catalog_cache[key] = remote_read(route, {"op":"catalog", "workspace":route["workspace"]})
        except BridgeError as exc: _remote_catalog_cache[key] = exc
    data = _remote_catalog_cache[key]
    if isinstance(data,BridgeError): raise data
    workspace = route["workspace"]
    if workspace.startswith("~/"): workspace = data["home"] + workspace[1:]
    records = [x for x in data["records"] if not context.get("provider") or x["provider"] == context["provider"]]
    exact = [x for x in records if x["cwd"] == workspace]
    return [dict(wrap_remote_record(x,route,context),route_match=bool(exact)) for x in (exact or records)]


def route_for_context(context):
    if not isinstance(context,dict): raise BridgeError("Invalid remote history context")
    prefix = select_session(context)
    found = agents(prefix)
    agent = next((a for a in found if a.get("pane_id")==context.get("target") and a["identity"]==context.get("identity")),None)
    if not agent: raise BridgeError("远端窗格已改变，请刷新会话列表")
    info = call(prefix+["pane","process-info","--pane",agent["pane_id"]]).get("process_info",{})
    queue = [(p.get("pid"),p.get("argv",[])) for p in info.get("foreground_processes",[])]; seen=set()
    while queue and len(seen)<64:
        pid, initial = queue.pop(0)
        if not isinstance(pid,int) or pid in seen: continue
        seen.add(pid); snapshot=process_snapshot(pid); argv=snapshot["argv"] if snapshot else initial
        route=ch_ssh_route(argv)
        if route: return route
        if snapshot: queue.extend((child,[]) for child in snapshot["children"])
    raise BridgeError("远端 SSH 路由已断开，请刷新会话列表")


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
    data={"op":"history","record_id":key[len(prefix):],"workspace":route["workspace"]}
    if "before" in request: data["before"]=request["before"]
    result=remote_read(route,data)
    result["record"]=wrap_remote_record(result["record"],route,context)
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
    with path.open("rb") as stream:
        for _ in range(32):
            line = stream.readline(2_000_001); read += len(line)
            if len(line) > 2_000_000 or read > 4_000_000: break
            try: row = json.loads(line)
            except (ValueError, UnicodeError): continue
            if not isinstance(row,dict): continue
            if provider == "codex" and row.get("type") == "session_meta":
                value = row.get("payload", {})
                source = value.get("source", {})
                sub = source.get("subagent", {}) if isinstance(source, dict) else {}
                # Internal guard/review workers are not user conversations.
                if isinstance(sub, dict) and sub.get("other") in ("guardian", "review"):
                    return None
                spawn = sub.get("thread_spawn", {}) if isinstance(sub, dict) else {}
                meta.update(thread=value.get("id", path.stem), cwd=value.get("cwd", ""),
                            parent=value.get("parent_thread_id") or spawn.get("parent_thread_id"),
                            role=value.get("agent_nickname") or value.get("agent_role") or
                                 (sub.get("other", "") if isinstance(sub, dict) else ""))
            if provider == "codex" and row.get("type") == "response_item":
                message = row.get("payload", {})
                if message.get("role") == "user" and not meta["title"]:
                    title = text_content(message.get("content", []))
                    if title and not title.startswith(("<", "# AGENTS")):
                        meta["title"] = title[:100]
            if provider == "claude":
                meta["cwd"] = row.get("cwd", meta["cwd"])
                if "subagents" in path.parts:
                    meta["parent"] = path.parent.parent.name
                    meta["thread"] = path.stem.removeprefix("agent-")
                else: meta["thread"] = row.get("sessionId", path.stem)
                if row.get("type") == "user" and not row.get("isMeta") and not meta["title"]:
                    title = text_content(row.get("message", {}).get("content", ""))
                    if title and not title.startswith(("<", "# AGENTS")): meta["title"] = title[:100]
    meta["title"] = meta["title"] or meta["role"] or ("对话 · " + (Path(meta["cwd"]).name or str(meta["thread"])[:8]))
    return meta


def transcript_catalog(write_cache=True):
    cache_path = Path.home() / ".local/state/herdr-pocket/catalog-v3.json"
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
    def add(kind, text, title="", call_id=""):
        if not text: return
        result.append({"id": str(offset) + ":" + str(len(result)), "kind": kind,
                       "text": text.encode("utf-8")[:16000].decode("utf-8", errors="ignore"), "title": title, "call_id": call_id,
                       "timestamp": timestamp, "truncated": len(text.encode("utf-8")) > 16000})
    if provider == "codex":
        if row.get("type") != "response_item": return []
        value = row.get("payload", {}); kind = value.get("type")
        if kind == "message" and value.get("role") in ("user", "assistant"):
            if value.get("channel") not in ("analysis", "summary"):
                text = text_content(value.get("content", []))
                if value.get("role") != "user" or not text.startswith(("# AGENTS.md", "<environment_context>", "<INSTRUCTIONS>")):
                    add(value["role"], text)
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
                try: values = normalize_record(json.loads(line), entry["provider"], offset)
                except (ValueError, TypeError, AttributeError): values = []
                messages[0:0] = values; before = offset
                if len(messages) >= 35: break
    return {"record": public_record(entry), "messages": messages, "before": before,
            "has_more": before > 0, "partial": partial, "bounded": before > 0 and len(messages)<35,
            "children": [public_record(x) for x in catalog if x["parent"] == entry["thread"] and x["provider"] == entry["provider"]]}


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
    if op not in ("agents", "read", "prompt", "key"):
        raise BridgeError("Unknown operation")
    prefix = select_session(request)
    found = agents(prefix, include_history=op == "agents")
    if op == "agents":
        return {"agents": found}
    target = request.get("target")
    agent = next((a for a in found if a.get("pane_id") == target), None)
    if not agent or request.get("identity") != agent["identity"]:
        raise BridgeError("Agent changed or disappeared; reload the agent list")
    if op == "read":
        return call(prefix + ["agent", "read", target, "--source", "recent-unwrapped", "--lines", "160"])
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
