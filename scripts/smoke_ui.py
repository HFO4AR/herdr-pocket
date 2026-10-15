#!/usr/bin/env python3
"""Android WebView UI smoke with only offline fixtures; never connects to a host."""
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET


def run(*args):
    return subprocess.check_output(["adb", *args], timeout=35)


def screen():
    run("shell", "uiautomator", "dump", "/sdcard/pocket-ui.xml")
    return ET.fromstring(run("exec-out", "cat", "/sdcard/pocket-ui.xml").decode())


def find(text, editable=False):
    nodes=list(screen().iter('node'))
    candidates=[x for x in nodes if 'EditText' in x.get('class','')] if editable else nodes
    for exact in [True,False]:
        for node in candidates:
            values=[node.get('text',''),node.get('content-desc','')]
            if any(text==v if exact else text in v for v in values): return node
    # WebView exposes empty inputs without their computed HTML label in UIAutomator.
    # Resolve the adjacent visible label to the following input in accessibility order.
    if editable:
        for i,node in enumerate(nodes):
            if text == node.get('text',''):
                for following in nodes[i+1:]:
                    if 'EditText' in following.get('class',''): return following
        if text == '消息输入框' and len(candidates)==1: return candidates[0]
    return None


def tap(text, editable=False):
    for _ in range(5):
        node=find(text,editable)
        if node is not None:
            x1,y1,x2,y2=map(int,re.findall(r'\d+',node.attrib['bounds']))
            run('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2));time.sleep(.6);return
        if editable:
            run('shell','input','swipe','540','1200','540','650','250')
        time.sleep(.6)
    raise AssertionError('Missing UI action: '+text)


def fill(label,text):
    tap(label,True);run('shell','input','text',text)


def expect(text):
    for _ in range(5):
        if find(text) is not None:return
        time.sleep(.5)
    raise AssertionError('Missing UI text: '+text)


def screenshot(name):
    Path('ui-artifacts').mkdir(exist_ok=True)
    Path('ui-artifacts',name+'.png').write_bytes(run('exec-out','screencap','-p'))


def main():
    live=[line.split()[0] for line in run('devices').decode().splitlines()[1:] if line.endswith('\tdevice')]
    assert len(live)==1 and live[0].startswith('emulator-'),'Require sole emulator, never phone'
    os.environ['ANDROID_SERIAL']=live[0]
    vault=run('shell','am','instrument','-w','dev.herdr.pocket.test/dev.herdr.pocket.SecureProfilesTest').decode()
    assert 'vault-tests: PASS (2 tests)' in vault,vault
    print('PASS: Keystore save/reload/no plaintext/destination change/forget/delete',flush=True)
    run('shell','am','start','-W','-n','dev.herdr.pocket/.MainActivity')
    tap('添加第一台设备')
    fill('设备名称','Test-workstation')
    fill('主机地址','fixture.invalid')
    fill('SSH 用户名','fixture')
    fill('登录密码','test-password')
    run('shell','input','keyevent','4')
    tap('保存设备');expect('密码已加密保存')
    run('shell','am','force-stop','dev.herdr.pocket')
    run('shell','am','start','-W','-n','dev.herdr.pocket/.MainActivity')
    expect('Test-workstation');expect('密码已加密保存')
    print('PASS: device/password survives process restart',flush=True)
    tap('体验聊天演示')
    expect('在线会话');screenshot('agents')
    tap('把移动端做成真正的聊天工具')
    expect('历史记录、子 Agent 和执行的命令都要能看到。')
    screenshot('agent')
    run('shell','input','swipe','540','700','540','1900','300')
    tap('加载更早消息')
    time.sleep(.5)
    run('shell','input','swipe','540','700','540','1900','300')
    expect('先把连接设备和密码保存做好。')
    tap('命令');expect('Ran 24 tests');screenshot('commands')
    tap('对话')
    fill('消息输入框','draft-check');expect('发送消息');screenshot('keyboard')
    run('shell','input','keyevent','4')
    tap('发送消息');expect('草稿已保留')
    tap('切换 Agent');tap('布局检查 · 子 Agent · demo-chi')
    expect('子 Agent：布局检查完成。');screenshot('subagent')
    assert find('消息输入框',True) is None,'Child record must not send to parent'
    tap('返回列表');expect('draft-check')
    run('shell','settings','put','system','accelerometer_rotation','0')
    run('shell','settings','put','system','user_rotation','1');time.sleep(2)
    expect('draft-check');expect('发送消息');screenshot('landscape')
    run('shell','settings','put','system','user_rotation','0');time.sleep(2)
    tap('返回列表');tap('历史');expect('历史记录');screenshot('history')
    tap('我的');expect('workstation.local');screenshot('account')
    print('PASS: chat, pagination, commands, child isolation, drafts, keyboard, rotation, history and SSH info; no real host calls',flush=True)


if __name__=='__main__':
    try: main()
    except Exception:
        screenshot('failure')
        Path('ui-artifacts/failure.xml').write_bytes(ET.tostring(screen()))
        raise
