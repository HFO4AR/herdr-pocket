# v0.6.0 CC Switch model switching (2026-10-20, preview-87)

- Added read-only `ccswitch`/`providers` and guarded `ccswitchSwitch` bridge ops for Claude and Codex. Provider listing returns names, model slots and the current marker only; tokens, keys, base URLs, full settings config and arbitrary paths are never returned. Switching refuses official/no-config providers, backs up every replaced file 0600, merges common + provider config while preserving user fields, writes atomically 0600, updates `~/.cc-switch/settings.json` and `providers.is_current`, and never restarts a running Agent.
- PASS: 11 new Python tests in `tests/test_ccswitch.py` (temporary HOME and fake SQLite DB): redaction, current detection (settings.json + DB), Claude/Codex merge rules, 0600 backups/atomic outputs, invalid app/ids, official/empty refusal, missing/corrupt DB, bad common config, hook/model-slot replacement, no-secret responses, limited TOML reader vs stdlib. No test opens the real `~/.cc-switch`, `~/.claude` or `~/.codex`.
- PASS: `scripts/test_ccswitch_ui.cjs` (add to `npm test`): opens the sheet from the conversation menu, Claude/Codex tabs, current highlight, model slots, refresh, official rows disabled, confirmation stating new sessions only, Claude and Codex switch calls, friendly missing-CC-Switch state, dark 320 px and tablet layouts with no overflow, and no page errors. Fixture responses include token/base-URL fields that must not render.
- Read-only check on this workstation: CC Switch 3.20.2's `ccswitch --help`, `provider list` and `provider current` printed nothing while the GUI was running, so no official CLI was used. A **copy** of the real DB/settings/configs in a temporary home listed 15 Claude/Codex providers (DeepSeek current for Claude, Codex `default` official), switched Claude and Codex on the copy, and verified token absence, status-line preservation, Codex user projects/tui/mcp preservation and 0600 outputs. The real files were not switched.
- NOT VERIFIED: a real phone-triggered switch against the user's live config (deliberately avoided), physical handset, or the CC Switch GUI refreshing while locked. See SECURITY.md for the direct-config path and its limits.

# v0.4.0 terminal and missing-history fixes (2026-10-15)

- Added a persistent SSH PTY view with bundled xterm.js, resizing, UTF-8 byte streaming, direct keyboard and explicit line submission. Returning to the list preserves the shell; disconnect/explicit close ends it. No reconnect or input replay.
- Added ordinary Herdr panes across all workspaces with recent output snapshots, explicit target checks, text/run/key input and durable request receipts. The app does not close shared panes.
- Fixed the actual login password dialog: remember-password checkbox is present there, and successful authentication saves the secret encrypted. Failed authentication does not replace the stored password. Version and save state are visible under My Connection.
- Fixed history discovery beyond Herdr's optional session ID: exact native resume IDs, transcript paths/FDs, authorized ch-cli SSH route discovery; clear candidates when no unique binding exists. Fixed large internal tails, cross-window pagination and duplicate rollouts for the same thread. Read errors now remain visible with a retry action.
- PASS: 40 Python bridge regressions. Browser checks cover remote history without a Herdr ID, remote picker context, the actual connection dialog's remember request, terminal views, stale-target/draft isolation, narrow/landscape layouts and reduced motion. Local Android debug and instrumentation builds pass.
- Read-only current-workstation check: 10 live panes; 5 reliably auto-associated (1 Herdr ID, 2 explicit native resume IDs, 2 unique remote route threads). The other 5 expose readable candidates, not a claim that the first candidate belongs to the active pane. No real Agent or ordinary live terminal received test input.
- Remote reads use existing SSH routing with strict host-key verification and only the authorized Codex/Claude history roots. No provider login files, remote installers or remote cache writes. The phone's SSH account view remains about the directly connected SSH user.
- NOT VERIFIED: Physical handset, the user's Sakura Frp path, or input delivery to a real Herdr pane. Do not equate fixture SSH checks with those paths.

Validated source: `d3d69ea`. [Successful full CI](https://github.com/HFO4AR/herdr-pocket/actions/runs/38701840215) and [signed preview-17](https://github.com/HFO4AR/herdr-pocket/releases/tag/preview-17).

- PASS: Android lint/debug/release builds; emulator connected to isolated OpenSSH fixture with a pinned host key, installed the exact bundled bridge over SFTP, read synthetic history over SSH, and verified PTY UTF-8/cwd/resize/Ctrl+C/stale-target/duplicate-input behavior.
- PASS: Real Android Keystore persistence, process restart, connection dialog remember checkbox, chat/history/tools/child navigation, rotation, SSH and Herdr terminal pages and demo input isolation. Native terminal screenshots inspected.
- PASS: Downloaded published APK is `0.4.0-dev.17` / code 117; SHA-256 `170cf7ec5fd36befaee6cdd43cb54ab1cae81f19d97f17507f80833096a88107` matches the release checksum and `apksigner` validates the persistent release certificate.
- During verification, UI automation initially observed a not-yet-ready Android accessibility tree; observations now retry against a fresh dump, never replaying input. A terminal CSS class collision was corrected after inspecting browser screenshots.

---

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
