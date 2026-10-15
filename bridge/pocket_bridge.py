#!/usr/bin/env python3
"""Herdr Pocket protocol v1. One bounded JSON request over SSH stdin."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys

VERSION = "0.3.0"
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
    if "agent" in args and args[args.index("agent") + 1] == "read":
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


def agents(prefix):
    found = call(prefix + ["agent", "list"]).get("agents", [])
    return [dict(a, identity=identity(a)) for a in found]


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


def transcript_catalog():
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
            except (OSError, ValueError, TypeError): continue
    try:
        import tempfile
        cache_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=cache_path.parent, delete=False) as stream:
            json.dump(new_cache, stream); temp = stream.name
        os.replace(temp, cache_path)
    except OSError: pass
    return sorted(entries, key=lambda x: x["modified"], reverse=True)


def public_record(value):
    return {k: v for k, v in value.items() if k != "_path"}


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
                       "text": text[:16000], "title": title, "call_id": call_id,
                       "timestamp": timestamp, "truncated": len(text) > 16000})
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
    window_start = max(0, cursor - 2_000_000); start = window_start
    messages, partial = [], False
    with entry["_path"].open("rb") as stream:
        stream.seek(start)
        if start: stream.readline(min(cursor-start, 2_000_000))
        start = min(stream.tell(), cursor)
        data = stream.read(max(0, cursor - start))
    lines, pos = [], start
    for line in data.splitlines(keepends=True):
        if not line.endswith(b"\n"):
            partial = True; continue
        lines.append((pos, line)); pos += len(line)
    before = window_start
    for offset, line in reversed(lines):
        try: values = normalize_record(json.loads(line), entry["provider"], offset)
        except (ValueError, TypeError, AttributeError): values = []
        messages[0:0] = values; before = offset
        if len(messages) >= 35: break
    return {"record": public_record(entry), "messages": messages, "before": before,
            "has_more": before > 0, "partial": partial, "bounded": window_start > 0 and len(messages)<35,
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
    if op not in ("agents", "read", "prompt", "key"):
        raise BridgeError("Unknown operation")
    prefix = select_session(request)
    found = agents(prefix)
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
