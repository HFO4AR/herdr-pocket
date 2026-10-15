# Security

- SSH host keys are pinned per hostname/port after explicit user confirmation. A mismatch is rejected; there is no permissive fallback.
- Each device logs in with a password or with the phone's SSH key (see "SSH key login" below). Passwords are only persisted when the user chooses to remember them, encrypted together with device profiles using AES-GCM and an Android Keystore key. Passwords are never returned by the device-list API, logged or copied to the clipboard. Changing the host, port or username does not reuse a saved password. Android backup is disabled. Screenshots are allowed by default (the user asked for it); 设置 → 防截图 sets FLAG_SECURE on every screen, which also hides the app in the recent-apps preview. Password fields are always masked.
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

## SSH key login

- The app holds one SSH identity for the whole phone (like a person's `~/.ssh/id_ed25519`): every computer already trusts the same phone, so per-computer keys would add bookkeeping without protection. A computer is revoked by removing the line from its `authorized_keys`; 「重新生成」 (with a confirmation) revokes all at once.
- New keys are Ed25519, generated on the phone with JSch/BouncyCastle. The private key is serialized as an OpenSSH key and stored only as AES-GCM ciphertext (with associated data) under a separate, non-exportable Android Keystore key `pocket.identity.v1`, in its own preferences file, excluded from backup. It is decrypted into a byte array only for one SSH handshake (connect, silent reconnect, or the post-install test login) and wiped afterwards; JSch's parsed copy is dropped with `removeAllIdentity()` once authentication is over. There is no export, display, clipboard or log path for the private key; the WebView only ever receives the public key line and its SHA-256 fingerprint.
- Importing an existing key is optional: the file is picked with the system document picker and read natively (≤ 16 KB, OpenSSH / PEM / PKCS#8; Ed25519, ECDSA, RSA ≥ 2048), never passed to the WebView. A passphrase-protected key needs its passphrase, which is used once to decrypt and not stored; the key is then re-sealed under the Keystore key like a generated one. Public-key files, DSA and short RSA keys are refused.
- A key device stores no password (choosing 「密钥」 deletes a saved one), connects and reconnects without any password, and uses public-key authentication only. Host-key pinning is unchanged: the same pinned key is required for key logins and silent reconnects.
- 「装公钥」 writes to the connected computer only after a confirmation sheet that shows the exact line and what will be done; native code re-checks that the line is still the phone's current key. Over SFTP on the existing password session it creates `~/.ssh` (0700) if missing, appends that one line to `~/.ssh/authorized_keys` unless the same key type and blob are already present (no duplicates), gives a new file 0600 and only removes group/other write bits from an existing `~/.ssh` or file. It reads the file back to confirm the line, never edits or removes other lines and touches no other file. It then tries one key login on a separate session and reports the result; switching the device to key login (and deleting its saved password) is a separate, explicit choice.
- A rejected key reports `key_rejected` with the next step (install the public key; check `~/.ssh` 700, `authorized_keys` 600, home not writable by others); a computer without public-key auth reports `key_method`. Anyone with this unlocked phone and the app can log in to computers that trust its key, exactly as with a saved password.

## Reconnects and background alerts

- A silent reconnect only uses the host key already pinned for that host and port; a changed key stops reconnecting and is reported. It never shows a new trust prompt on its own.
- The password for a reconnect comes from the encrypted vault, or, if the device does not remember it, from memory for the current app process only. It is cleared on disconnect. Key devices reconnect with the Keystore-sealed key and need no password.
- A request is re-sent after reconnecting only when it provably never reached the host: the session was already down, or the exec channel failed to open (stdin is streamed only after the channel opens). Anything that failed after being written keeps the "outcome unknown" error and is never replayed.
- Reconnecting ends the previous interactive SSH shell; it is not resumed.
- The background watcher is a foreground service with a visible notification and a stop action. It only runs the read-only `status` operation, never sends prompts or keys, and stops when the app returns to the foreground, on disconnect, after five consecutive failures or after eight hours. Notifications contain the agent title and state only, not message content.

## Pictures and files sent from the phone

- Pictures and files are uploaded with SFTP into `~/.herdr-pocket/uploads/<UTC day>/` only (folders 0700, files 0600); a file keeps its sanitized original name inside a folder named after the first 16 hex characters of its SHA-256. Names are checked again by the bridge (one path segment, no leading dot, no control/format/bidi or line-separator characters, ≤ 180 bytes), so they cannot traverse paths or hide lines in a prompt. Symlinked folders or files are refused. Files are streamed from the system document picker without a storage permission and never pass through the WebView.
- The bridge re-hashes every upload before naming it in a prompt, and the prompt only carries paths, not file contents. Uploads older than 14 days are deleted opportunistically, and only the file kinds the phone writes.
- For a pane attached to another computer through ch-cli, files are copied there **before** the prompt, through the same live route used for remote history (`BatchMode=yes`, strict host-key checking, forwarding disabled, no control master). This writes to the other computer, confined to that SSH user's `~/.herdr-pocket/uploads/<day>/<prefix>/<name>`: real non-symlinked folders owned by the user, created with umask 077, a size and SHA-256 check, and no replacement of an existing different file. Any failure (unreachable, timeout, mismatch) stops before the prompt with a "没发出去" message, so nothing reaches the agent. Panes that SSH elsewhere without a ch route are refused. Pictures for ch routes still use `ch share-image` (`ch` has no command for other files).

## Local cache on the phone

To show something immediately on launch, the app caches the last session list, the first page of the history catalog and the most recent part (up to 80 messages) of chats the user opened. Cache entries live in the app's no-backup files directory, one subdirectory per saved device, with hashed file names, encrypted with AES-GCM under a separate Android Keystore key (`pocket.cache.v1`). Entries are capped at 1.5 MB each and 32 MB in total, evicting least recently used entries first. Deleting a device deletes its cache; Settings can clear the whole cache. A decryption failure (key removed, file damaged) discards the entry. Demo mode never writes the cache.

Cached content is display only: while SSH is still connecting the cached chat is read-only and no input can be sent; send targets always come from a fresh read after the connection is up. Native cache calls are scoped to the connected device or a device saved in the encrypted vault.

## History and bundled UI

History access is limited to JSONL files within the SSH user's `~/.codex/sessions` and `~/.claude/projects`. (The one exception, a file opened on explicit request in the read-only viewer, is described under "Viewing project files" below.) Remote requests use catalog-issued SHA-256 record IDs, not filesystem paths. Symlinks escaping the roots are rejected. To tell which conversation a live Codex pane is showing, the bridge also reads thread names from `~/.codex/session_index.jsonl` and the file names (thread IDs) in `~/.codex/thread-writer-locks/`; it never opens the lock files or any Codex auth/config file. The account endpoint returns only SSH username and hostname; no provider authentication/config files are read.

Adapters exclude system/developer messages, private reasoning and internal guardian records. Commands/results are historical evidence, never executable UI. Text uses DOM text nodes, not HTML interpolation. Transcript sources are private third-party formats and remain version-sensitive.

Update checks: besides the user's own SSH host, the app's only network traffic is the update check against `api.github.com/repos/HFO4AR/herdr-pocket/releases` (on launch at most every 12 hours, can be turned off in 设置, no device or account data sent) and, when the user taps update, the APK download from that repository's releases. A download is handed to the Android installer only if its SHA-256 matches the release's published digest, its package name is ours, its version code is newer and it is signed by the same certificate as the installed app; the system installer still asks the user to confirm. These requests run natively, never from the WebView.

The Android WebView only runs UI assets packaged in the APK, with network loads, external navigation, file/content access and frames blocked. CSP disables external scripts/resources. Native RPC results are JSON values, never concatenated HTML. UI tests contain fake devices only. Encrypted data is excluded from Android backup; losing the Keystore key means saved credentials need to be entered again.


The SSH terminal opens a PTY only on explicit user action. It supports arbitrary shell input as a user terminal, including destructive commands; commands are never synthesized or automatically replayed. Output uses a bounded in-memory ring. xterm.js and its styles are bundled offline, with OSC 52 clipboard access suppressed. Closing the independent shell may terminate programs in it; returning to the list does not close it. Herdr pane input targets are revalidated and require durable UUID receipts.

The connection password dialog can now persist the supplied password after successful authentication. Failed authentication does not overwrite the saved secret. Passwords remain absent from device list responses and UI output.


For explicitly authorized ch-cli remote history access, the bridge reuses transport metadata from the live SSH attach process, with `BatchMode=yes`, strict host-key checking and forwarding disabled. It never copies or reads private-key contents, provider auth/config files, or process environment. Remote history roots remain the corresponding SSH user's `~/.codex/sessions` and `~/.claude/projects`. To find the live conversation the remote side reads only ch's non-secret tmux locator fields (`socket`, `session`, `pane`, `pid`, `start`) from the route's `session.sqlite`, lists that tmux session's panes, and reads `/proc` argv and FD link names of the native agent process; it never reads process environment, the ch bridge token or task file contents. Automatic resolution parses only the matched transcript, and the candidate list parses only the Claude project directory belonging to that route workspace. The adapter does not persist any remote cache of history data.

To keep remote reads fast (a fresh SSH login over a slow link takes seconds), two things are reused:

- **One SSH connection per route, owned by the bridge.** Reads multiplex over a control socket in `~/.herdr-pocket/ssh/cm-%C` on the computer running the bridge (folder 0700, owned by the user, not a symlink; otherwise the read connects without reuse). The route's own `-S`/control path and the user's ssh config control path are never used; the connection keeps `BatchMode=yes`, strict host-key checking and forwarding disabled, closes itself after 5 idle minutes, and is torn down after a timeout. If ssh itself fails on the shared connection, the read (never a write) is retried once over a fresh unshared connection. File copies to the other computer do not use the shared connection.
- **A content-addressed copy of the read adapter on the other computer.** The only remote command is a fixed loader that receives the adapter's SHA-256 as its argument and the request on stdin. It runs `~/.herdr-pocket/bridge/<sha256>.py` only if that file is a regular, non-symlinked file owned by the SSH user, not group/world-writable, and its bytes hash to exactly that SHA-256; otherwise it reports the copy missing and the bridge ships the adapter on stdin (verified against the same hash before it runs) and the adapter stores itself there atomically (folders 0700, file 0600). Only files named `<64 hex>.py` in that folder are pruned, keeping the newest three versions. The adapter is the public bridge source; it contains no credentials or request data.

Account display remains the primary SSH connection's username/hostname.

Remote record identifiers are bound to a rediscovered live route; the app cannot supply an arbitrary SSH destination or filesystem path. A unique dedicated ch-cli route workspace can identify its one native conversation. Generic cwd matches and ambiguous routes provide explicit read-only choices. Selecting history does not resume a provider session or send input. Temporary SSH/read failures remain visible and do not authorize mutation replay.

## Viewing project files (read-only, 0.6)

Besides history, the bridge can read one **project file** for display. This is opt-in per tap: a path in a message opens a sheet, and only tapping 「查看文件内容」 there sends a `fileView` request for that one file. Nothing is read ahead of time, in the background or for previews, the content is not written to the phone's cache, and the operation never writes, executes or lists anything. Searching inside a conversation runs on the phone over messages already loaded; it reads no files.

The `fileView` operation enforces, on the computer that has the file:

- **Where:** the path (absolute, `~/…`, or relative to the conversation's working directory) is resolved with `realpath`, so every symlink is followed, and the result must lie inside the SSH user's home folder or the conversation's project folder (the `cwd` recorded in the transcript the app has open, looked up by its record ID; a working directory sent by the app is only a base for relative paths, never an allowed root). `/` is never a root. A link that leads out of these folders is refused ("链接指向项目和主目录之外").
- **Never secrets:** refused by the requested path and again by the resolved path: anything under `.ssh`, `.gnupg`, `.aws`, `.password-store`, `.kube`, `.docker`, `~/.config/gh`, `~/.local/share/keyrings`; provider sign-in/config files (`~/.codex/auth*`, `~/.codex/config*`, `~/.claude/.credentials*`, `~/.claude/settings*`, `~/.claude.json`); and files named `.env*`, `*id_rsa*` / `*id_ed25519*` / `*id_ecdsa*` / `*id_dsa*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*keystore*`, `*.kdbx`, `*.ppk`, `.netrc`, `.pgpass`, `.git-credentials`, `.npmrc`, `.pypirc`, `credentials*`. The app shows "这是密钥、凭据或 .env 一类的敏感文件，不在手机上显示". This list cannot recognise every secret: a token pasted into an ordinary source file is shown like the rest of that file.
- **Only regular files:** directories, devices, pipes and sockets are refused before opening; the file is opened with `O_NOFOLLOW | O_NONBLOCK` and must still be the same regular file.
- **Bounded:** at most the first 512 KB are read and sent (the app says the file was cut and how big it is). Files with NUL bytes or mostly undecodable/control bytes are reported as binary and their content is not sent.

For a pane on another computer (ch-cli route), the same request goes through the remote read path described above (the stored, hash-checked adapter over the bridge's own SSH connection, request on stdin), and the same checks run on that computer against that SSH user's home folder, the route's workspace folder and the transcript's working directory there.

## Permissions and pane input (0.6)

- Photos: pictures come from the system photo picker, which grants access to what was picked; no storage permission is used. Some galleries (seen on MIUI) return a storage path or a provider that checks the photos permission instead. Only when reading such a picked picture is refused does the app ask for the standard photos permission (`READ_MEDIA_IMAGES`, or `READ_EXTERNAL_STORAGE` up to Android 12) and retry just those pictures. "All files access" is never requested.
- ch panes: the agent runs on another computer behind ch's local relay, so Herdr lists it but refuses its agent commands (`agent_not_ready`: not the pane foreground process). Only after that refusal (nothing was written) and only when the pane's process tree shows a ch route and no local agent process, the same input goes to the pane instead: `pane run` for one line, a single bracketed paste plus Enter for several lines, `pane send-keys` for keys. It is the one write for that request id; an unknown outcome is still never retried.
- 立即发送 sends Esc to a busy agent (Esc stops a turn in Claude Code and Codex and never quits them), waits until Herdr reports the same agent stopped, then sends the message through the normal checked path. If the agent does not stop within 20 s, nothing is sent.


## Feedback diagnostics

设置 → 帮助与反馈 → 反馈问题 builds a plain-text summary only when tapped, shows it in full, and copies it or opens `github.com/HFO4AR/herdr-pocket/issues/new` only on a further tap (nothing is attached to the URL). It holds the app, Android and WebView versions, the bridge's own version/protocol/Python version (read-only `hello`), whether Herdr is installed and how many sessions run (read-only `doctor`), fixed state words, counts, settings and up to eight recent native error **codes** with the operation name. Error messages are never kept, because they can name hosts, users or paths; codes and operation names must match strict patterns before they are stored, in memory only. Device names, host names, user names, paths, titles, message text, keys and fingerprints are never included.
