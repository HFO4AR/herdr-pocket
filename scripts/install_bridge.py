#!/usr/bin/env python3
"""Install the exact bundled bridge for the current SSH user, without sudo."""
import hashlib
import os
from pathlib import Path
import tempfile


def main():
    os.umask(0o077)
    source = Path(__file__).resolve().parents[1] / "bridge/pocket_bridge.py"
    content = source.read_bytes()
    folder = Path.home() / ".herdr-pocket"
    folder.mkdir(mode=0o700, exist_ok=True)
    target = folder / ("bridge-" + hashlib.sha256(content).hexdigest() + ".py")
    if target.exists():
        if target.read_bytes() != content:
            raise SystemExit("Existing content-addressed bridge differs; refusing to overwrite")
    else:
        fd, temp = tempfile.mkstemp(prefix=".install-", dir=folder)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
            os.replace(temp, target)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    print(target)
    print("Installed. The matching Android build can now choose Read sessions.")


if __name__ == "__main__":
    main()
