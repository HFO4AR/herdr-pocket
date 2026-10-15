# Security

- SSH host keys are pinned per hostname/port after explicit user confirmation. A mismatch is rejected; there is no permissive fallback.
- The app currently supports password authentication only. Passwords are only persisted when the user chooses to remember them, encrypted together with device profiles using AES-GCM and an Android Keystore key. Passwords are never returned by the device-list API, logged or copied to the clipboard. Changing the host, port or username does not reuse a saved password. Android backup is disabled. Screenshots are blocked on real connection/device-editing screens; offline demo conversation screens permit screenshots.
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

## Reconnects and background alerts

- A silent reconnect only uses the host key already pinned for that host and port; a changed key stops reconnecting and is reported. It never shows a new trust prompt on its own.
- The password for a reconnect comes from the encrypted vault, or, if the device does not remember it, from memory for the current app process only. It is cleared on disconnect.
- A request is re-sent after reconnecting only when it provably never reached the host: the session was already down, or the exec channel failed to open (stdin is streamed only after the channel opens). Anything that failed after being written keeps the "outcome unknown" error and is never replayed.
- Reconnecting ends the previous interactive SSH shell; it is not resumed.
- The background watcher is a foreground service with a visible notification and a stop action. It only runs the read-only `status` operation, never sends prompts or keys, and stops when the app returns to the foreground, on disconnect, after five consecutive failures or after eight hours. Notifications contain the agent title and state only, not message content.

## Pictures and files sent from the phone

- Pictures and files are uploaded with SFTP into `~/.herdr-pocket/uploads/<UTC day>/` only (folders 0700, files 0600); a file keeps its sanitized original name inside a folder named after the first 16 hex characters of its SHA-256. Names are checked again by the bridge (one path segment, no leading dot, no control/format/bidi or line-separator characters, ≤ 180 bytes), so they cannot traverse paths or hide lines in a prompt. Symlinked folders or files are refused. Files are streamed from the system document picker without a storage permission and never pass through the WebView.
- The bridge re-hashes every upload before naming it in a prompt, and the prompt only carries paths, not file contents. Uploads older than 14 days are deleted opportunistically, and only the file kinds the phone writes.
- For a pane attached to another computer through ch-cli, files are copied there **before** the prompt, through the same live route used for remote history (`BatchMode=yes`, strict host-key checking, forwarding disabled, no control master). This writes to the other computer, confined to that SSH user's `~/.herdr-pocket/uploads/<day>/<prefix>/<name>`: real non-symlinked folders owned by the user, created with umask 077, a size and SHA-256 check, and no replacement of an existing different file. Any failure (unreachable, timeout, mismatch) stops before the prompt with a "没发出去" message, so nothing reaches the agent. Panes that SSH elsewhere without a ch route are refused. Pictures for ch routes still use `ch share-image` (`ch` has no command for other files).

## History and bundled UI

History access is limited to JSONL files within the SSH user's `~/.codex/sessions` and `~/.claude/projects`. Remote requests use catalog-issued SHA-256 record IDs, not filesystem paths. Symlinks escaping the roots are rejected. To tell which conversation a live Codex pane is showing, the bridge also reads thread names from `~/.codex/session_index.jsonl` and the file names (thread IDs) in `~/.codex/thread-writer-locks/`; it never opens the lock files or any Codex auth/config file. The account endpoint returns only SSH username and hostname; no provider authentication/config files are read.

Adapters exclude system/developer messages, private reasoning and internal guardian records. Commands/results are historical evidence, never executable UI. Text uses DOM text nodes, not HTML interpolation. Transcript sources are private third-party formats and remain version-sensitive.

The Android WebView only runs UI assets packaged in the APK, with network loads, external navigation, file/content access and frames blocked. CSP disables external scripts/resources. Native RPC results are JSON values, never concatenated HTML. UI tests contain fake devices only. Encrypted data is excluded from Android backup; losing the Keystore key means saved credentials need to be entered again.


The SSH terminal opens a PTY only on explicit user action. It supports arbitrary shell input as a user terminal, including destructive commands; commands are never synthesized or automatically replayed. Output uses a bounded in-memory ring. xterm.js and its styles are bundled offline, with OSC 52 clipboard access suppressed. Closing the independent shell may terminate programs in it; returning to the list does not close it. Herdr pane input targets are revalidated and require durable UUID receipts.

The connection password dialog can now persist the supplied password after successful authentication. Failed authentication does not overwrite the saved secret. Passwords remain absent from device list responses and UI output.


For explicitly authorized ch-cli remote history access, the bridge reuses transport metadata from the live SSH attach process, with `BatchMode=yes`, strict host-key checking and forwarding disabled. It never copies or reads private-key contents, provider auth/config files, or process environment. Remote history roots remain the corresponding SSH user's `~/.codex/sessions` and `~/.claude/projects`. To find the live conversation the remote side reads only ch's non-secret tmux locator fields (`socket`, `session`, `pane`, `pid`, `start`) from the route's `session.sqlite`, lists that tmux session's panes, and reads `/proc` argv and FD link names of the native agent process; it never reads process environment, the ch bridge token or task file contents. Automatic resolution parses only the matched transcript, and the candidate list parses only the Claude project directory belonging to that route workspace. The adapter arrives through stdin and does not install remote files or persist a remote cache. Account display remains the primary SSH connection's username/hostname.

Remote record identifiers are bound to a rediscovered live route; the app cannot supply an arbitrary SSH destination or filesystem path. A unique dedicated ch-cli route workspace can identify its one native conversation. Generic cwd matches and ambiguous routes provide explicit read-only choices. Selecting history does not resume a provider session or send input. Temporary SSH/read failures remain visible and do not authorize mutation replay.
