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
