# Initial validation (2026-10-13)

- PASS: 12 Python bridge unit tests. Covers argument isolation, plain-text terminal output, protocol validation, session existence, agent replacement, busy-state refusal, allowed keys, duplicate/conflicting request IDs, and unknown outcomes.
- PASS: Android debug APK build with JDK 17 / Gradle 8.13 / AGP 8.11.0 / SDK 35.
- PASS: Packaged bridge bytes match the source exactly; third-party license files are bundled. The APK passes `apksigner verify` (v2 development signature).
- PASS: Manual content-addressed bridge install, protocol hello and session listing on the development host.
- PASS: Read-only bridge session discovery, agent listing, and current-agent output retrieval against Herdr 0.8.2 on Linux. No live Agent received test prompts or keys.
- PASS: GitHub Actions built the APK and ran Android lint successfully on source commit `8b27348`. [CI run](https://github.com/HFO4AR/herdr-pocket/actions/runs/38422527172). Local lint downloads were blocked by a Google Maven network timeout; independent CI completed them.
- PASS: Cloud Android API 35 emulator installed and launched the APK; checked connection-form validation, demo session selection, Agent list, output and refresh. Actual screenshots were inspected and a clipped multiline card title was fixed, then re-tested. See `screenshots/`. The local emulator 36.4.9 crashed before App installation; the independent cloud emulator supplied UI evidence.
- NOT VERIFIED: Physical Android device, real SSH login from the APK, SFTP install from the APK, prompt/key delivery from a phone, or the user's port-forwarding service with this APK.

This is an experimental first release, not production acceptance. Do not infer physical-device safety, background notifications, or full transcript synchronization from automated tests.
