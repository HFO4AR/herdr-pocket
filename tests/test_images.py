import base64
import hashlib
import json
import re
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import tempfile
import time
import unittest
import zlib
from unittest.mock import patch
from test_bridge import bridge


def png(width=3, height=2):
    raw = b"".join(b"\x00" + bytes([200, 90, 40]) * width for _ in range(height))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class ImageTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.state = self.home / "state"
        hp = patch.object(bridge.Path, "home", return_value=self.home); hp.start(); self.addCleanup(hp.stop)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_test", "agent": "claude", "agent_status": "idle"}
        self.commands = []
        call = patch.object(bridge, "call", side_effect=self.call); call.start(); self.addCleanup(call.stop)
        self.probe = {"ok": True, "route": None, "remote": False}
        probe = patch.object(bridge, "probe_pane", side_effect=lambda *a: self.probe); probe.start(); self.addCleanup(probe.stop)
        self.picture = png()
        self.sha = hashlib.sha256(self.picture).hexdigest()
        self.day = time.strftime("%Y-%m-%d", time.gmtime())
        self.folder = self.home / ".herdr-pocket/uploads" / self.day
        self.folder.mkdir(parents=True, mode=0o700)
        (self.folder / (self.sha + ".png")).write_bytes(self.picture)
        (self.folder / (self.sha + ".thumb.jpg")).write_bytes(b"\xff\xd8thumb")

    def call(self, args):
        self.commands.append(args)
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        return {"text": "ok"}

    def prompt(self, text="看看这个报错", images=None, **extra):
        images = images if images is not None else [{"name": self.day + "/" + self.sha + ".png", "sha256": self.sha}]
        request = dict(v=1, op="prompt", session="default", target="w1:p1", identity=bridge.identity(self.agent),
                       text=text, images=images, id="12345678-1234-1234-1234-123456789012")
        request.update(extra)
        return request

    def sent(self):
        return [c for c in self.commands if "prompt" in c]

    def receipts(self):
        path = self.state / "receipts.sqlite"
        return sqlite3.connect(path).execute("SELECT id FROM receipts").fetchall() if path.exists() else []

    def test_local_pane_gets_absolute_path_once(self):
        req = self.prompt()
        first = bridge.handle(req, self.state)
        self.assertEqual(bridge.handle(req, self.state), first)
        self.assertEqual(len(self.sent()), 1)
        text = self.sent()[0][-1]
        self.assertEqual(text, "看看这个报错\n\n[图片] " + str(self.folder / (self.sha + ".png")))
        self.assertEqual(first["text"], text)

    def test_more_than_four_images_are_allowed(self):
        images = [{"name": self.day + "/" + self.sha + ".png", "sha256": self.sha}] * 9
        result = bridge.handle(self.prompt(images=images, id="32345678-1234-1234-1234-123456789012"), self.state)
        self.assertEqual(len(self.sent()), 1)
        self.assertEqual(result["text"].count("[图片] "), 9)

    def test_image_only_prompt_is_allowed(self):
        bridge.handle(self.prompt(text=""), self.state)
        self.assertTrue(self.sent()[0][-1].startswith("[图片] /"))
        with self.assertRaises(bridge.BridgeError):
            bridge.handle(dict(self.prompt(text=" "), images=None, id="22345678-1234-1234-1234-123456789012"), self.state)

    def test_bad_images_are_not_sent_and_leave_no_receipt(self):
        cases = [[{"name": "../../etc/passwd", "sha256": self.sha}],
                 [{"name": self.day + "/" + "0" * 64 + ".png", "sha256": "0" * 64}],
                 [{"name": self.day + "/" + self.sha + ".png", "sha256": "f" * 64}]]
        for images in cases:
            with self.assertRaises(bridge.BridgeError):
                bridge.handle(self.prompt(images=images), self.state)
        (self.folder / (self.sha + ".png")).write_bytes(self.picture + b"x")
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去"):
            bridge.handle(self.prompt(), self.state)
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.receipts(), [])

    def test_symlinked_upload_is_refused(self):
        outside = self.home / "secret.png"; outside.write_bytes(self.picture)
        link = self.folder / ("a" * 64 + ".png"); link.symlink_to(outside)
        with self.assertRaisesRegex(bridge.BridgeError, "没传到"):
            bridge.handle(self.prompt(images=[{"name": self.day + "/" + "a" * 64 + ".png", "sha256": "a" * 64}]), self.state)

    def test_ch_route_shares_the_picture_and_sends_the_address(self):
        self.probe = {"ok": True, "route": {"ssh": ["host"], "workspace": "~/.local/share/ch/workspaces/x", "key": "k"}, "remote": True}
        address = "ch-file://" + self.sha + ".png"
        with patch.object(bridge.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, address + "\n", "")) as run:
            bridge.handle(self.prompt(), self.state)
        self.assertEqual(run.call_args.args[0][1:], ["share-image", str(self.folder / (self.sha + ".png"))])
        # A note after the address: a pasted line ending in "….png" makes Claude read the clipboard ("Pasting…").
        self.assertEqual(self.sent()[0][-1], "看看这个报错\n\n[图片 · ch-local fetch] " + address + " " + bridge.CH_IMAGE_NOTE)
        self.assertFalse(any(re.search(r"\.(png|jpe?g|gif|webp)\s*$", line) for line in self.sent()[0][-1].split("\n")))

    def test_failed_share_or_plain_ssh_pane_is_not_sent(self):
        self.probe = {"ok": True, "route": {"ssh": ["host"], "workspace": "w", "key": "k"}, "remote": True}
        for output in ("", "ch-file://" + "0" * 64 + ".png"):
            with patch.object(bridge.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output, "")):
                with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：图片没能交给 ch"):
                    bridge.handle(self.prompt(), self.state)
        self.probe = {"ok": True, "route": None, "remote": True}
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：这个窗格连着别的电脑"):
            bridge.handle(self.prompt(), self.state)
        self.probe = {"ok": True, "route": None, "remote": False}
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去"):
            bridge.handle(self.prompt(remote=True), self.state)
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.receipts(), [])

    def image(self, **request):
        return bridge.handle(dict(v=1, op="image", **request))

    def test_serves_thumbnails_only_from_uploads_and_ch_cache(self):
        thumb = self.image(kind="upload", name=self.day + "/" + self.sha + ".png")
        self.assertEqual(base64.b64decode(thumb["data"]), b"\xff\xd8thumb")
        full = self.image(kind="upload", name=self.day + "/" + self.sha + ".png", variant="full")
        self.assertEqual((base64.b64decode(full["data"]), full["mime"]), (self.picture, "image/png"))
        # A ch address of one of our uploads uses the upload's thumbnail.
        self.assertEqual(self.image(kind="ch", address="ch-file://" + self.sha + ".png")["bytes"], 7)
        other = png(5, 5); sha = hashlib.sha256(other).hexdigest()
        cache = self.home / ".local/share/ch/attachments"; cache.mkdir(parents=True)
        (cache / (sha + ".png")).write_bytes(other)
        self.assertEqual(base64.b64decode(self.image(kind="ch", address="ch-file://" + sha + ".png")["data"]), other)
        for bad in ({"kind": "upload", "name": "../../.ssh/id_rsa"}, {"kind": "upload", "name": "/etc/passwd"},
                    {"kind": "ch", "address": "ch-file://../../x.png"}, {"kind": "file", "path": "/etc/passwd"},
                    {"kind": "ch", "address": "ch-file://" + "1" * 64 + ".png"}):
            with self.assertRaises(bridge.BridgeError): self.image(**bad)

    def test_large_picture_is_shrunk_or_refused(self):
        big = b"\x89PNG" + b"0" * (bridge.SERVE_LIMIT + 10)
        with patch.dict("sys.modules", {"PIL": None}):
            with self.assertRaisesRegex(bridge.BridgeError, "太大"):
                bridge.image_payload(big, "image/png", "full")
            # Without Pillow a mid-sized thumbnail is served as it is.
            self.assertEqual(bridge.image_payload(b"x" * 300_000, "image/png", "thumb")["bytes"], 300_000)
        with self.assertRaises(bridge.BridgeError): bridge.image_payload(b"<svg/>", "image/svg+xml", "thumb")

    def test_transcript_pictures_become_thumbnails(self):
        data = base64.b64encode(self.picture).decode()
        claude = {"type": "user", "message": {"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}},
            {"type": "text", "text": "[Image #1] 这是什么"}]}}
        rows = bridge.normalize_record(claude, "claude", 120)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["text"], rows[0]["images"]), ("[Image #1] 这是什么", [{"block": 0}]))
        self.assertNotIn(data, json.dumps(rows))
        only = bridge.normalize_record({"type": "user", "message": {"content": [claude["message"]["content"][0]]}}, "claude", 7)
        self.assertEqual((only[0]["kind"], only[0]["text"], only[0]["images"]), ("user", "", [{"block": 0}]))
        codex = {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": "<image name=[Image #1]>"},
            {"type": "input_image", "image_url": "data:image/png;base64," + data},
            {"type": "input_text", "text": "</image>"}, {"type": "input_text", "text": "看图"}]}}
        rows = bridge.normalize_record(codex, "codex", 5)
        self.assertEqual((rows[0]["text"], rows[0]["images"]), ("看图", [{"block": 1}]))
        # The image op reads the same block back from the transcript line.
        root = self.home / ".claude/projects/p"; root.mkdir(parents=True)
        lines = [json.dumps({"type": "user", "message": {"content": "hi"}}) + "\n", json.dumps(claude) + "\n"]
        (root / "s.jsonl").write_text("".join(lines))
        with patch.object(bridge, "transcript_roots", return_value=[("claude", self.home / ".claude/projects")]):
            record = bridge.handle({"v": 1, "op": "catalog"})["records"][0]
            page = bridge.handle({"v": 1, "op": "history", "record_id": record["id"]})
            item = next(m for m in page["messages"] if m.get("images"))
            got = self.image(kind="transcript", record_id=record["id"], item=item["id"], block=0, variant="full")
            self.assertEqual(base64.b64decode(got["data"]), self.picture)
            for bad in ({"item": item["id"], "block": 1}, {"item": "0:0", "block": 0}, {"item": "x", "block": 0}, {"item": "999999:0", "block": 0}):
                with self.assertRaises(bridge.BridgeError): self.image(kind="transcript", record_id=record["id"], variant="full", **bad)

    def test_old_upload_days_are_pruned(self):
        old = self.home / ".herdr-pocket/uploads/2020-01-01"; old.mkdir()
        (old / (self.sha + ".png")).write_bytes(b"x"); (old / (self.sha + ".thumb.jpg")).write_bytes(b"x")
        keep = self.home / ".herdr-pocket/uploads/2020-01-02"; keep.mkdir(); (keep / "notes.txt").write_text("mine")
        bridge.prune_uploads()
        self.assertFalse(old.exists())
        self.assertTrue((keep / "notes.txt").exists())
        self.assertTrue((self.folder / (self.sha + ".png")).exists())


if __name__ == "__main__":
    unittest.main()
