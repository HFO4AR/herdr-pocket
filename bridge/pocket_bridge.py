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

VERSION = "0.1.0"
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


def handle(request, state_dir=None):
    if not isinstance(request, dict) or request.get("v") != 1:
        raise BridgeError("Expected protocol version 1")
    op = request.get("op")
    if op == "hello":
        return {"version": VERSION, "protocol": 1}
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
