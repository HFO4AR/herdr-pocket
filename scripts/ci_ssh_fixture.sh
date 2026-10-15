#!/usr/bin/env bash
# Ephemeral CI-only SSH server, accessible solely through emulator host loopback.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'CI runner only'; exit 1; }
sudo apt-get update -qq
sudo apt-get install -y -qq openssh-server
sudo useradd -m -s /bin/bash pocket-fixture
printf '%s\n' 'pocket-fixture:pocket-fixture-password' | sudo chpasswd
fixture_dir="$RUNNER_TEMP/pocket-ssh-fixture"
mkdir -p "$fixture_dir"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/host_key"
cat > "$fixture_dir/sshd_config" <<CONFIG
Port 22222
ListenAddress 127.0.0.1
HostKey $fixture_dir/host_key
PidFile $fixture_dir/sshd.pid
PasswordAuthentication yes
# Key login is tested too: the app installs its public key over the password session (StrictModes stays on).
PubkeyAuthentication yes
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers pocket-fixture
UsePAM no
PrintMotd no
Subsystem sftp internal-sftp
CONFIG
sudo mkdir -p /run/sshd
sudo /usr/sbin/sshd -f "$fixture_dir/sshd_config" -E "$fixture_dir/log"
awk '{print "POCKET_FIXTURE_PIN=" $2}' "$fixture_dir/host_key.pub" >> "$GITHUB_ENV"

sudo -u pocket-fixture mkdir -p /home/pocket-fixture/.codex/sessions
sudo -u pocket-fixture tee /home/pocket-fixture/.codex/sessions/fixture.jsonl >/dev/null <<'JSONL'
{"type":"session_meta","payload":{"id":"fixture-thread","cwd":"/tmp/pocket-fixture"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"SSH fixture history"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Read through SSH successfully"}]}}
JSONL

# A fake, read-only Herdr in the fixture user's ~/.local/bin (the bridge's documented fallback when
# `herdr` is not on PATH). It answers with one canned Codex agent bound to fixture-thread above, so the
# UI smoke can connect for real and see the bridge's own output end to end. Anything else is refused.
sudo -u pocket-fixture mkdir -p /home/pocket-fixture/.local/bin
sudo -u pocket-fixture tee /home/pocket-fixture/.local/bin/herdr >/dev/null <<'HERDR'
#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if args[:1] == ["--session"]: args = args[2:]
AGENT = {"pane_id": "w1:p1", "terminal_id": "term-fixture", "workspace_id": "w1", "tab_id": "w1:t1",
         "agent": "codex", "agent_status": "idle", "agent_session": {"value": "fixture-thread"},
         "terminal_title": "Fixture 端到端会话", "cwd": "/tmp/pocket-fixture"}
def reply(value):
    print(json.dumps({"result": value})); sys.exit(0)
if args == ["session", "list", "--json"]: reply({"sessions": [{"name": "default", "running": True, "default": True}]})
if args[:2] == ["agent", "list"]: reply({"agents": [AGENT]})
if args[:2] == ["workspace", "list"]: reply({"workspaces": []})
if args[:2] == ["agent", "read"]: print("fixture terminal\n› "); sys.exit(0)
print(json.dumps({"error": {"code": "fixture_unsupported", "message": "fixture herdr: " + " ".join(args[:3])}})); sys.exit(1)
HERDR
sudo chmod 755 /home/pocket-fixture/.local/bin/herdr
