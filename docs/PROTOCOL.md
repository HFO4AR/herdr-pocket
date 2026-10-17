# Protocol 1

Transport: SSH exec `python3 <quoted-content-addressed-bridge-path>`. UTF-8 JSON line on stdin, JSON object on stdout. No PTY. Maximum input 65536 bytes; maximum prompt 16000 UTF-8 bytes. Herdr subprocess timeout 20 seconds; phone response timeout 35 seconds.

Request fields:

| Field | Meaning |
|---|---|
| `v` | Integer `1` |
| `op` | `hello`, `sessions`, `agents`, `read`, `prompt`, `key`, `catalog`, `history`, `account` |
| `session` | Required for all agent operations; must exist and be running |
| `target` | Explicit live pane ID for read/prompt/key |
| `identity` | Bridge-issued identity digest from the agent list |
| `id` | Mutation UUID for prompt/key; same ID must never have different payload |
| `text` | Prompt content |
| `key` | One of up/down/left/right/enter/esc/ctrl+c |

Responses: `{"ok":true,"data":{...}}` or `{"ok":false,"error":"..."}`.
Hello returns `protocol` and bridge `version`. Sessions omit server filesystem paths. Agents currently preserve Herdr's JSON fields plus an `identity` digest. Read returns Herdr's result object. Prompt/key success means input was sent, not that an agent task completed.

The identity hashes terminal ID, agent kind and available agent-session metadata. Concurrent replacement can still race with CLI execution; this is documented rather than represented as an atomic guarantee.

Errors never authorize a retry. Reuse the same UUID if implementing explicit recovery; an unfinished receipt reports unknown instead of replaying. The current phone UI uses manual inspection after failures and does not implement automated recovery.

## Read-only transcript extension (bridge 0.3.0)

Protocol stays v1; deployments are content-addressed, so the app always installs its exact bundled adapter version.

- `catalog`: optional `query` (max 200 characters), `offset` (nonnegative integer), `thread` (exact session/thread identifier). Returns `records`, `total`, nullable `next`; pages contain at most 100 metadata records.
- `history`: `record_id` from catalog and optional `before` byte offset. Returns normalized `messages`, `children`, `before`, `has_more`, and bounded/partial indicators. Default reads the latest window; byte cursors keep older pages stable when the file is appended. Each scan window is 2 MB; a page skips sparse/internal tails across up to 16 MB total. Normal rows crossing window boundaries retain complete-line cursors. Each displayed block is capped at 16 KB UTF-8, marked `truncated`.
- Message kinds: `user`, `assistant`, `tool`, `result`; fields include stable byte-offset `id`, `timestamp`, `text`, `title`, `call_id`, `truncated`. Commands/results link by `call_id` when both are present in loaded pages; a result without its call is shown independently.
- `account`: returns `ssh_user` and `hostname` only. Does not read provider accounts, tokens, email addresses or plans.

History does not require a running Herdr session and never accepts a caller-selected filesystem path. A SHA-256 identifier resolves only through the approved transcript roots. A history record is not a terminal target. Only explicit live-agent or ordinary-pane operations can send input, with session/identity checks and mutation receipts. Independent SSH shell input uses its own terminal identity and sequence.

Codex adapters read session_meta and response_item records; Claude adapters read user/assistant message blocks and the documented subagents layout. Private reasoning/system/developer records are omitted. Related upstream references: [Codex rollout reducer](https://github.com/openai/codex/blob/main/codex-rs/rollout-trace/src/reducer/thread.rs), [Claude subagent documentation](https://code.claude.com/docs/en/sub-agents). Local fixture and installed-version verification is required when schemas change.


## Terminal extension (v0.4.0, protocol remains v1)

- `panes(session)`: ordinary panes in all workspaces; includes pane/terminal/tab/workspace IDs and identity. Recognized Agents are excluded.
- `paneRead(session,target,identity)`: validates the live ordinary pane and reads 400 recent-unwrapped lines.
- `paneRun` / `paneText`: validated destination plus text, UUID receipt; run appends Enter, text does not. Input is bounded to 16000 UTF-8 bytes. `paneKey` accepts only the documented logical key allowlist. Existing durable receipt semantics prevent replay of uncertain results.
- The independently opened SSH PTY does not use the Python bridge. Native `shellOpen` allocates an opaque terminal ID. Read uses an absolute byte cursor over a 1 MiB ring, returns base64 bytes, next cursor, lost/ended/error. Renderer consumes UTF-8 bytes incrementally. Poll retries are non-destructive.
- Native writes carry terminal ID and strictly increasing sequence. The sequence is consumed before socket write; unknown outcomes freeze the UI input stream. No auto retry, reconnect, or replay. Resize is clamped to 20–400 columns and 5–200 rows; close only closes the explicitly opened shell channel.
- No terminal bytes or typed commands are persisted by the app. The remote shell may maintain its own shell history. Real-server checks stay read-only; mutation tests use isolated CI fixtures.


## History association and remote routing (v0.4.0)

`agents` adds `history_ref` without changing the original agent identity digest. A `matched` reference has `record_id`, `thread`, and `source` (`herdr`, `process`, or `ch-route`); remote matches also include `record` and `remote`. Herdr transcript-path references must already exist in the allow-listed catalog. Native process `resume` / `--resume` UUIDs and open transcript FD links are exact evidence. Duplicate rollout copies with the same provider/thread select the most recently modified copy. Generic project cwd or recency never authorizes automatic matching.

Unresolved references explicitly report `unavailable`, `missing`, `ambiguous`, `remote`, `remote_candidates`, `remote_missing`, or `remote_error`, with optional `reason`, `query`, and up to 12 inline metadata `candidates`. These are suggestions for explicit selection, not send destinations. Manual association retains the existing pane/identity and requires the app's explicit confirmation.

History resolution uses the strongest available evidence, and a weaker source never overrides a stronger one:

1. **native-process** — the live Claude process holds its runtime directory `/tmp/claude-<uid>/<project>/<session-id>/tasks` open; the session ID in that FD link is the conversation currently on screen (it follows `/clear` and `/resume`).
2. **title** — the Codex TUI sets the terminal title to `<thread name> | <cwd name>`. It is matched against `~/.codex/session_index.jsonl` names, preferring threads the Codex app-server has loaded (`~/.codex/thread-writer-locks/<id>.lock`). Duplicate names are only accepted when exactly one is loaded.
3. **open-file** — a transcript JSONL the native process holds open.
4. **herdr** — Herdr's reported `agent_session` (can be stale after switching sessions inside the TUI).
5. **process** — `--resume`/`resume` IDs in argv (startup only; stale after an in-app switch).

For a live ch-cli SSH attach, process argv identifies the established SSH destination and route workspace. One SSH round trip per remote account (all accounts in parallel) runs op `resolve`, which applies rule 1 inside ch's tmux pane and opens only the matching transcript. When no live ID is found, the candidates are the root conversations in that route's own Claude project directory; they are never selected by newest timestamp.

Remote records have IDs `remote:<route digest>:<opaque record hash>` and a `remote` context containing Herdr `session`, `target`, `identity`, and provider. `catalog` and `history` accept that context; each request revalidates the live pane and rediscovers its SSH route. A stale route or mismatched namespace fails explicitly. Children and parent navigation preserve remote context. Catalog query/offset/thread semantics remain the same; local catalog remains available without a live Herdr session, while remote routes require their live attach pane.

Remote reads execute only allow-listed resolve/catalog/history/image reads, through one fixed loader command: `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ControlMaster=auto -o ControlPath=~/.herdr-pocket/ssh/cm-%C -o ControlPersist=300 <route args without -S> python3 -I -c '<loader>' <adapter sha256>`. stdin is `<n>\n`, n adapter bytes (0 = use the stored copy), then the JSON request line. The loader runs `~/.herdr-pocket/bridge/<sha256>.py` of the remote user only when it is a regular, user-owned, non-writable-by-others file whose bytes hash to that SHA-256; otherwise it answers `{"helper_missing":true}` and the bridge resends with the adapter on stdin, which is hash-checked, run and stored atomically (0700/0600, newest 3 kept). An unsafe or over-long control folder falls back to `ControlMaster=no -o ControlPath=none`; a timeout tears the shared connection down, and an ssh failure (exit 255) is retried once without sharing. No remote cache of history data is written. Measured over a 275 ms link: ~1 s per warm read, ~4.5 s for the first read after 5 idle minutes (new SSH login). One remote host index (including failures) is reused within a bridge request. Each SSH read has at most 15 seconds; agent enrichment has a 22-second aggregate remote budget. Remote output is capped at 2 MB and oversized/error responses are reported, never converted into an empty history. The UI keeps errors visible with an explicit retry button.


## Pictures (protocol remains v1)

- **Phone**: pictures come from the system photo picker (or `ACTION_GET_CONTENT` before it exists) or the camera app writing into a private, non-exported provider; no storage or camera permission. Each picture is rotated upright, scaled to a 2048 px long edge and re-encoded (PNG kept when small, otherwise JPEG ≤ 1.3 MB), which drops EXIF including location. Bytes stay native; the WebView gets a 360 px preview and an opaque id.
- **Upload** (native SFTP, not a bridge op): `~/.herdr-pocket/uploads/<UTC day>/<sha256>.<jpg|png>` plus `<sha256>.thumb.jpg`; folders 0700, files 0600, written to a temp name and renamed. Content-addressed, so a retry finds or rewrites the same file. Uploading never touches an agent.
- `prompt` accepts `images`: 1–4 `{name: "<day>/<sha256>.<ext>", sha256}` and an optional `remote` hint; `text` may then be empty (≤ 15000 bytes). Before the receipt is written the bridge checks each name, that it is a regular non-symlinked file of this user, and its SHA-256, then probes the pane: a local pane gets `[图片] <absolute path>` lines after the text; a ch-cli route runs `ch share-image <path>` (it only caches the file and prints `ch-file://<sha256>.<ext>`, which must match the hash) and gets `[图片 · ch-local fetch] <address>` lines; a pane that SSHes elsewhere without a ch route is refused. All of these refusals start with `没发出去` and leave no receipt. The result adds the final `text`. For a Claude Code or Codex agent the bridge first reads the coloured visible screen; text already in the agent's own input box refuses the prompt (`没发出去：它的输入框里已经有字了…`, no receipt), since it would go out joined to it. An empty box's placeholder or suggestion is told apart by being drawn dim/grey; when the screen cannot be read, has no colours or shows no input box, the prompt goes as before. Day folders older than 14 days are pruned opportunistically.
- `image`: `variant` `thumb`/`full`; `kind` `upload` (`name`), `ch` (`address`; our upload with that hash first, else `~/.local/share/ch/attachments/<sha256>.<ext>`), or `transcript` (`record_id`, message `item` id, content `block`, optional `remote` context; reads that one line back and decodes the embedded Claude base64 / Codex data-URL picture). Never a caller-chosen path. Returns `{mime, data(base64), bytes}`; at most 1.35 MB, shrunk with Pillow when installed, otherwise refused. The phone re-encodes it to ≤ 360/1600 px before the WebView sees it.
- `history` user messages carry `images: [{block}]` for pictures embedded in the transcript; the placeholder text and Codex `<image>` wrappers are dropped.

## Files (protocol remains v1)

- **Phone**: any file from the system document picker (`ACTION_OPEN_DOCUMENT`, multi-select, no storage permission); at most 4 per message and 25 MB each. The name is sanitized on the phone (NFC; `/` and `\` become `_`; control, format/bidi, line-separator and private-use characters dropped; no leading dot or space; ≤ 120 UTF-8 bytes keeping the extension). Only an id, the name and the size reach the WebView.
- **Upload** (native SFTP, not a bridge op): the content URI is streamed and hashed on the way into `~/.herdr-pocket/uploads/<UTC day>/.<random>.part`, then moved to `<UTC day>/<first 16 hex of sha256>/<name>` (folders 0700, file 0600). The same content and name land on the same path, so a retry is harmless. Then `fileCheck {name, sha256}` re-hashes it on the computer; a wrong copy is deleted (`{match:false}`) and uploaded once more.
- `stageFile {session, target, identity, name, sha256, remote?}`: run by the phone for every file before the prompt; never sends input to an agent. It re-hashes the upload and probes the pane: a local pane returns `{remote:false, path}`; a ch-cli route copies the file to the other computer (below) and returns `{remote:true, path}`; any other SSH pane is refused with `没发出去：…`.
- **Remote copy**: `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ControlMaster=no -o ControlPath=none -o ClearAllForwardings=yes -o ConnectTimeout=8 <route args without -S> python3 -c '…'`, with the bundled adapter and then the file's bytes on stdin (≤ 25 s). It writes only `~/.herdr-pocket/uploads/<day>/<prefix>/<name>` of that SSH user (umask 077, real non-symlinked folders owned by the user, `O_EXCL|O_NOFOLLOW` temp file), checks size and SHA-256, and links it into place without ever replacing a different file. Remote day folders older than 14 days are pruned the same way.
- `prompt` accepts `files`: 1–4 `{name: "<day>/<prefix>/<name>", sha256}` (with or without `images`; `text` may then be empty). Before the receipt the bridge re-hashes each file; a local pane gets `[文件] <absolute path>` lines after any `[图片]` lines; a ch route first checks over the same SSH route that every staged copy exists with that hash, then gets `[文件] <remote absolute path>` lines. Every refusal starts with `没发出去` and leaves no receipt.
- `fileInfo {names: [≤ 60 relative names]}` → `{files: {name: {size} | {gone: true}}}` for history chips (invalid names are skipped). The phone shows history lines `[文件] …/.herdr-pocket/uploads/<day>/<prefix>/<name>` as chips; tapping one offers to copy the path or the name. Nothing is downloaded back to the phone.

## New sessions (protocol remains v1)

- `createInfo(session)`: read-only. Installed kinds (`codex`, `claude`, `ch`; looked up on PATH and common user bin folders), workspaces with the shell directories their panes use, and suggested directories (pane directories first, then up to 12 recent history directories that still exist; temp and hidden folders are skipped).
- `create(session, id, kind, cwd, workspace)`: no other fields are accepted. `kind` is one of the three above; `workspace` is an existing workspace ID (new tab there) or `new` (new workspace). `cwd` (absolute, `~`, `~/…`, or relative to `$HOME`) must be an existing directory without `..`, resolved through symlinks, and either inside `$HOME` (no hidden components) or the real path of a directory a live pane or recent history already uses (they may name it through a symlink). All of this is checked, and the executable must be found, before the UUID receipt is written; these refusals start with `没创建`, and so do failed reads before the receipt (session offline, Herdr not answering the workspace list).
- Herdr primitives only, never focusing the new tab: `tab create --workspace <id> --cwd <dir> --no-focus` or `workspace create --cwd <dir> --no-focus`, then `agent start pocket-<id prefix> --kind <codex|claude> --pane <new pane> --timeout 3100` (no agent arguments), or for `ch` the fixed text `ch new` via `pane run` into the brand-new shell pane, followed by about 3 s of `pane get` looks for a Claude there. The short wait is deliberate: Herdr 0.8 needs a timeout above 3000 ms, and when it runs out the agent keeps starting in the pane (checked with Herdr 0.8.2), so the request answers in about 4 s instead of waiting for the whole startup; the phone polls the rest. A shell that is not at its prompt yet (`agent_pane_busy` in Herdr 0.8.2, `agent_pane_unavailable` before; nothing typed) is retried for up to 8 s, then reported as `failed` with `typed: false`. A Herdr that refuses the timeout value (`invalid_agent_timeout`, nothing typed) gets one retry with 20000 ms. Everything stays within a 26 s cap.
- Result: `{created, kind, cwd, pane_id, tab_id, workspace_id, new_workspace, state}` with `state` `ready`, `blocked` (startup question, e.g. folder trust), `starting` (not visible yet / timed out; may still come up) or `failed` (`code`, `detail`, `typed`). The receipt is saved as soon as the tab exists, so a retry with the same ID reports that pane instead of creating another; an unfinished receipt reports unknown. A tab whose agent failed is left open, never closed automatically.
- `starting` without `detected`: the phone closes the sheet at once and shows a 「正在启动」 row at the top of 会话 (per computer and Herdr session). It polls the read-only `status` every 1.5 s until Herdr lists an agent in that pane, then opens its chat (or, when something else is on screen, says so and keeps the first message as that agent's draft). After 45 s the row says it is taking long; after 2 minutes it stops asking and stays until dismissed (「不等了」, which only forgets the row). Nothing is ever started again from there; an unknown `create` outcome still says to refresh first.
- The optional first message is not part of `create`: the app sends it afterwards with a normal `prompt` (its own receipt) only when the new agent is listed as idle; otherwise it stays in the input box.

## Closing sessions (protocol remains v1)

- `closeInfo(session, target, identity)`: read-only. Re-checks that the pane still holds what the phone showed (the agent's identity, or for a plain shell pane `identity(pane)`), then returns `{pane_id, agent, agent_status, focused, workspace_label, tab_label, tab_panes, workspace_panes, exit_command, ch, ch_session}`. `ch` is true when the pane's process tree is a live ch-cli SSH attach.
- `exitAgent(session, target, identity, id)`: a normal receipt-backed mutation (same path as `prompt`; no other fields). Only for an `idle`/`done` agent; the bridge picks the text itself — Claude Code `/exit`, Codex `/quit` — and submits it with `agent prompt`. Herdr's not-sent refusals come back as `没发出去：…`. The pane stays a shell. Result adds `command`.
- `closePane(session, target, identity, id)`: no other fields. The receipt is written first; then the live pane is re-checked (refusals are stored as `{closed:false, refused}` and reported as `没关：…`), and only `herdr pane close <target>` runs. A Herdr refusal is `没关：…` (stored as `{closed:false, code}`); a timeout leaves the receipt open and reports `关闭结果未知：…` (the same id then never runs again). Result `{closed:true, pane_id, agent, verified}`, `verified` when a follow-up `pane get` says `pane_not_found`. The phone never retries either op on its own; every tap uses a fresh id.
- ch-cli panes: the local pane only runs the SSH attach to a tmux session on the other computer (`destroy-unattached off`, `remain-on-exit off`). Closing the local pane detaches and leaves that session running (`ch resume`); exiting the agent ends the remote session and the local attach returns to its shell.
- `hidden(add?, remove?)`: history records hidden in the app. Only record IDs (64 hex, or `remote:<24 hex>:<64 hex>`, ≤ 200 per call, ≤ 2000 kept) in `~/.local/state/herdr-pocket/hidden-records.json` (0600). Transcripts are never touched; the app filters its list and shows them under 「已隐藏」.

## Agents in tmux panes (protocol remains v1)

`tmux` lists the panes of every tmux server of the SSH user: the default one and named ones (`tmux -L name`) found as sockets in the user's tmux socket directories (see SECURITY.md). Result: `{available, panes, looked, skipped, servers}`. A pane of a named server has `pane_id` `%N@<12 hex>` (its server's key; default-server panes keep plain `%N`) and `server` (the socket name); every op that takes a pane id (`tmuxRead`, `tmuxSend`, `tmuxKill`, the agent ops below) reaches exactly that server with `-S <socket>`. `tmuxNew` always creates on the default server and `tmuxInfo.sessions` names only default-server sessions. `looked` = the socket directories read (the default one even when missing), `skipped` = up to 8 `{path, reason}` that were refused (not owned by the user, group/world-writable, symlink), `servers` = `{name, default, state: running|none|error, panes[, error]}` per server.

A Claude Code / Codex process found in a tmux pane of the SSH user (`tmux` op, `agent` on a pane) is addressed by `target` = tmux pane id (`%N`, or `%N@<key>` on a named server) and the agent `identity` (pane identity + agent pid + start time). The agent ops then run on tmux instead of Herdr, with the same receipts and refusal wording:

- `read`: `{text, agent_status, modes, bg[, ansi][, menu]}`. The state comes from the screen: `blocked` when a numbered menu parses, `working` when the footer offers "esc to interrupt", else `idle`. `menu` (parse_menu) is attached while blocked, or with `menu: true`.
- `status` with a target: `{tmux: true, agents: [row]}` (one process walk and one screen read; empty when the pane or its agent is gone). `status` with `tmux: true` and no target: Herdr's status rows when `session` is named and Herdr exists, followed by every tmux agent row (the background watcher).
- `prompt`: only while the screen reads idle (`Agent is busy or waiting for confirmation…` / `没发出去：Agent 正停在…` otherwise; the phone queues) and the agent's input box is empty (`没发出去：它的输入框里已经有字了…`). Codex reads idle only with its own composer and footer on screen. `images` / `files` name the phone's uploads, re-hashed before the receipt; the pane is local, so the prompt gets `[图片] <path>` / `[文件] <path>` lines. Several lines go in as one bracketed paste, then Enter.
- `stageFile`: re-hashes the upload and returns `{remote: false, path}`.
- `answer`: same request as for Herdr. The receipt is written before the first key; keys are `tmux send-keys Up|Down|Enter`, the text row gets `send-keys -l -- <text>`, and the screen is re-read after every key (`capture-pane`), stopping before Enter on any doubt.
- `key`: the agent key list; `shift+tab` is sent as `BTab` only while the agent's input footer is on screen and no menu waits.
- `exitAgent` is refused (close the pane with `tmuxKill`).
