#!/usr/bin/env python3
"""Offline UI smoke test on a sole Android emulator; never connects to a host."""
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET


def run(*args):
    return subprocess.check_output(["adb", *args], timeout=25)


def screen():
    run("shell", "uiautomator", "dump", "/sdcard/pocket-ui.xml")
    return ET.fromstring(run("exec-out", "cat", "/sdcard/pocket-ui.xml").decode())


def find(text):
    for node in screen().iter("node"):
        if text in node.get("text", ""):
            return node
    return None


def tap(text):
    for attempt in range(4):
        node = find(text)
        if node is not None:
            x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.attrib["bounds"]))
            run("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2))
            time.sleep(1)
            return
        run("shell", "input", "swipe", "500", "1600", "500", "500", "300")
    raise AssertionError("Missing UI action: " + text)


def main():
    devices = run("devices").decode().splitlines()[1:]
    live = [line.split()[0] for line in devices if line.endswith("\tdevice")]
    assert len(live) == 1 and live[0].startswith("emulator-"), "Require exactly one emulator, never a physical phone"
    os.environ["ANDROID_SERIAL"] = live[0]
    run("shell", "am", "start", "-W", "-n", "dev.herdr.pocket/.MainActivity")
    tap("连接电脑")
    assert find("填写主机、用户名和有效端口") is not None
    tap("先看看界面")
    tap("demo  →")
    assert find("你的 Agent") is not None
    output = Path("ui-artifacts"); output.mkdir(exist_ok=True)
    (output / "agents.png").write_bytes(run("exec-out", "screencap", "-p"))
    tap("移动端界面设计")
    assert find("这是演示内容") is not None
    (output / "agent.png").write_bytes(run("exec-out", "screencap", "-p"))
    tap("刷新输出")
    assert find("这是演示内容") is not None
    tap("继续这段对话")
    run("shell", "input", "text", "draft-check")
    assert find("发送") is not None, "Composer must remain visible above keyboard"
    (output / "keyboard.png").write_bytes(run("exec-out", "screencap", "-p"))
    run("shell", "input", "keyevent", "4")  # hide keyboard
    tap("发送")
    assert find("草稿已保留") is not None
    run("shell", "input", "keyevent", "4")  # back to list, not disconnect
    assert find("你的 Agent") is not None
    tap("移动端界面设计")
    assert find("draft-check") is not None, "Draft lost on navigation"
    run("shell", "settings", "put", "system", "accelerometer_rotation", "0")
    run("shell", "settings", "put", "system", "user_rotation", "1")
    time.sleep(2)
    assert find("draft-check") is not None, "Rotation lost draft"
    assert find("发送") is not None
    (output / "landscape.png").write_bytes(run("exec-out", "screencap", "-p"))
    run("shell", "settings", "put", "system", "user_rotation", "0")
    time.sleep(2)
    run("shell", "input", "keyevent", "4")
    tap("搜索会话")
    run("shell", "input", "text", "nonexistent")
    assert find("没有匹配的会话") is not None
    print("PASS: form, session, list, output, keyboard composer, safe demo send, back, drafts, rotation and search; zero host connections")



if __name__ == "__main__":
    main()
