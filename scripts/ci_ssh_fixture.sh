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

# Deterministic Office fixtures (Python zipfile, no external tools) for real SFTP preview checks.
sudo -u pocket-fixture python3 - <<'PY'
import os, zipfile
home = os.path.expanduser("~")
out = os.path.join(home, "office")
os.makedirs(out, exist_ok=True)
rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
pkg = "http://schemas.openxmlformats.org/package/2006/relationships"
def save(name, parts):
    path = os.path.join(out, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for part, text in parts:
            info = zipfile.ZipInfo(part, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, text)
def types(override, ctype):
    return f'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/{override}" ContentType="{ctype}"/></Types>'
def root(target):
    return f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{pkg}"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="{target}"/></Relationships>'
save("report.docx", [
 ("[Content_Types].xml", types("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")),
 ("_rels/.rels", root("word/document.xml")),
 ("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>CI Office fixture</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'),
])
save("budget.xlsx", [
 ("[Content_Types].xml", types("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")),
 ("_rels/.rels", root("xl/workbook.xml")),
 ("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + rel + '"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
 ("xl/_rels/workbook.xml.rels", f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{pkg}"><Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
 ("xl/worksheets/sheet1.xml", '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Total</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>'),
])
save("deck.pptx", [
 ("[Content_Types].xml", types("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml")),
 ("_rels/.rels", root("ppt/presentation.xml")),
 ("ppt/presentation.xml", f'<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="{rel}"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'),
 ("ppt/_rels/presentation.xml.rels", f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{pkg}"><Relationship Id="rId1" Type="{rel}/slide" Target="slides/slide1.xml"/></Relationships>'),
 ("ppt/slides/slide1.xml", '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="10058400" cy="1143000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="4000" b="1"/><a:t>CI deck</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
])
PY

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
