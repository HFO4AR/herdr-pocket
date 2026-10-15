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

For a live ch-cli SSH attach, process argv identifies the established SSH destination and dedicated route workspace. Only a single top-level provider thread in that exact route workspace is automatically matched. Multiple threads, or no exact workspace match, expose remote read-only candidates; they are not selected by newest timestamp.

Remote records have IDs `remote:<route digest>:<opaque record hash>` and a `remote` context containing Herdr `session`, `target`, `identity`, and provider. `catalog` and `history` accept that context; each request revalidates the live pane and rediscovers its SSH route. A stale route or mismatched namespace fails explicitly. Children and parent navigation preserve remote context. Catalog query/offset/thread semantics remain the same; local catalog remains available without a live Herdr session, while remote routes require their live attach pane.

Remote reads send the bundled Python adapter through SSH stdin and execute only allow-listed catalog/history reads. They install no files and write no remote cache. One remote host index (including failures) is reused within a bridge request. Each SSH read has at most 15 seconds; agent enrichment has a 22-second aggregate remote budget. Remote output is capped at 2 MB and oversized/error responses are reported, never converted into an empty history. The UI keeps errors visible with an explicit retry button.
