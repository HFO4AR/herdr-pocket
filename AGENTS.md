# Working on Herdr Pocket

- This is an independent Android + Python project. Keep real endpoints, credentials, SSH keys, conversation transcripts, and machine-specific paths out of tracked files.
- Do not send messages or keys to live agents while testing without explicit task authorization. Use fake CLI fixtures for mutation tests; live checks are read-only.
- Never disable host-key verification, automatically approve agent dialogs, replay timed-out mutations, or restart a user's Herdr server to make a test pass.
- Keep Android/bridge protocol versions aligned. Maintain auditable install and migration behavior.
- Run bridge tests, Android build and lint for affected changes. State which emulator/phone/real-server checks actually ran.
- Do not commit APKs, keystores, local.properties or toolchain caches. Release artifacts belong in GitHub Releases or CI artifacts.
