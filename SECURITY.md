# Security

- SSH host keys are pinned per hostname/port after explicit user confirmation. A mismatch is rejected; there is no permissive fallback.
- The app currently supports password authentication only. Passwords are never persisted, logged or copied to the clipboard. Android backup is disabled. Screenshots are blocked on real connection screens; offline demo screens permit screenshots.
- The public bridge source is bundled with the app. Install requires an explicit action, uses SFTP, verifies uploaded bytes, and names the file by SHA-256. No downloaded remote installer is executed.
- SSH requests have timeouts and bounded response size. Prompt input is bounded and passed as one subprocess argument, never evaluated as shell code.
- Only existing running sessions and recognized agents are targeted. The bridge does not run arbitrary shell commands, create agents, stop Herdr servers, or bypass approval dialogs.
- Mutations require a UUID. A private SQLite receipt is committed before invoking Herdr. If a process dies, a retry with the same ID refuses to execute again. The app never automatically retries a mutation. A user manually submitting again generates a new ID; inspect output first after unknown outcomes.
- The bridge stores hashes and receipts under `~/.local/state/herdr-pocket`, not prompt text. Receipts are not automatically pruned yet.
- SSH credentials authorize the user's full account outside this application. The bridge is not a sandbox and cannot constrain someone who independently has SSH access.
- Physical machinery, irreversible actions, and third-party project safety requirements still require their own authorization. A remote Enter is a real keypress.

For a vulnerability, use GitHub private vulnerability reporting if enabled, or contact the repository owner without posting credentials or exploit details publicly.

## Distribution signing

Automated distributions from v0.2.0 use a dedicated release key (not the v0.1.0 debug certificate).
Certificate SHA-256:

```
89301ebbfcd50523b4fac88ec9f6a68d61fba2b41a8d6ad136c972c7caf10fee
```

Check with Android SDK `apksigner verify --print-certs herdr-pocket.apk`.
The APK checksum is distributed alongside each release. Signing secrets are only available to main/tag builds;
pull requests cannot publish. Publication waits for build, lint, bridge tests and offline emulator checks.
