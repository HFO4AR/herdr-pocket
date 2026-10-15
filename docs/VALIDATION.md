# v0.3.0 chat and Host-style validation (2026-10-15)

Validated source: `9edfe3c`. [CI and automatic release](https://github.com/HFO4AR/herdr-pocket/actions/runs/38696764336).

- Host App default light/coral style: warm paper background, coral selections, ink primary actions, shared font order and 10/14/20 px geometry; mobile chat layout and touch targets remain. Dark theme selection is not included.
- PASS: 24 Python bridge regressions covering read-only history parsing/pagination, parent-child links, path boundaries, tool results and existing mutation safeguards.
- PASS: Browser tests for saved-device form, chat, older history, tools/results, independent child records, draft retention, explicit history binding when Herdr session ID is absent, 320 px width, landscape/tablet and reduced motion. Browser screenshots were visually inspected.
- PASS: Local Android debug and instrumentation APK builds.
- Local read-only checks parsed Codex and Claude records including tool outputs and parent-child metadata. The bridge only reads history roots; account information is SSH username/hostname only. No provider login files were read and no real Agent received prompts or keys.
- NOT VERIFIED: Physical phone, real APK SSH/SFTP operations, prompt/key delivery or foreground polling over the user's Sakura Frp tunnel. The offline tests do not certify those paths.
- Saved devices and opted-in passwords survive process restart using Android Keystore AES-GCM. Active SSH connections and in-memory drafts still end on process death. Child/archive views are read-only; sending requires a validated live pane.

- PASS: CI Android lint/debug/release builds and API 35 emulator: two real Keystore tests, process restart with saved device/password, chat/history pagination, command results, child isolation, draft retention, keyboard, rotation and SSH info. Native chat, keyboard and landscape screenshots inspected.
- PASS: Automatic signed [preview-14 release](https://github.com/HFO4AR/herdr-pocket/releases/tag/preview-14). APK SHA-256: `956bc8566bcc180bf8750fee493b9454692f79efb0362ab12b65a95afd36603d`; signing certificate matches the persistent release key documented in SECURITY.md.

---

# v0.2.0 redesign validation (2026-10-14)

Validated source: `97ded4a`. [Successful CI and automatic release](https://github.com/HFO4AR/herdr-pocket/actions/runs/38563814065).
[Signed preview APK](https://github.com/HFO4AR/herdr-pocket/releases/tag/preview-7).

- PASS: 12 bridge unit tests; local debug build; cloud Android lint and debug/release builds.
- PASS: API 35 emulator checked connection form validation, demo session selection, Agent list, output refresh, visible composer above keyboard, safe demo send, hierarchical back navigation, draft retention, rotation and search empty state.
- PASS: Actual emulator screenshots inspected: portrait list/output, software keyboard and landscape. See `screenshots/` (offline demo data only).
- PASS: Dedicated signed release APK independently downloaded; `apksigner verify --print-certs` and SHA-256 checksum verified. Public signing certificate is documented in SECURITY.md.
- PASS: GitHub Actions automatically published `preview-7` only after all checks passed. Main pushes produce signed preview releases; `v*` tags produce versioned releases.
- Fixed during verification: font constants rejected by lint; demo polling overwrote send feedback; toolbar alignment and default button shadows.
- NOT VERIFIED: This version on a physical phone, real APK SSH/SFTP operations, real foreground polling, or prompt/key delivery through the user's tunnel. No real Agent received test input.
- Rotation preserves the Activity; process death still disconnects and discards in-memory credentials/drafts. Terminal output remains a recent plain-text snapshot, not full conversation history.

---

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
