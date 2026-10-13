# Initial validation (2026-10-13)

- PASS: 12 Python bridge unit tests. Covers argument isolation, plain-text terminal output, protocol validation, session existence, agent replacement, busy-state refusal, allowed keys, duplicate/conflicting request IDs, and unknown outcomes.
- PASS: Android debug APK build with JDK 17 / Gradle 8.13 / AGP 8.11.0 / SDK 35.
- PASS: Packaged bridge bytes match the source exactly; third-party license files are bundled.
- PASS: Read-only bridge session discovery, agent listing, and current-agent output retrieval against Herdr 0.8.2 on Linux. No live Agent received test prompts or keys.
- LOCAL ENVIRONMENT BLOCKED: Android lint dependency download from Google Maven timed out; CI runs the same lint task independently.
- LOCAL ENVIRONMENT BLOCKED: Installed Android emulator 36.4.9 crashed with SIGSEGV during Android startup in hardware and software modes, before this App was installed. UI rendering and navigation have not been verified.
- NOT VERIFIED: Physical Android device, real SSH login from the APK, SFTP install from the APK, prompt/key delivery from a phone, or the user's port-forwarding service with this APK.

This is an experimental first release, not production acceptance. Do not infer physical-device safety, background notifications, or full transcript synchronization from automated tests.
