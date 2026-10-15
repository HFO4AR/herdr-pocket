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
- `history`: `record_id` from catalog and optional `before` byte offset. Returns normalized `messages`, `children`, `before`, `has_more`, and bounded/partial indicators. Default reads the latest window; byte cursors keep older pages stable when the file is appended. The read window is 2 MB. Each displayed block is capped at 16 KB UTF-8, marked `truncated`.
- Message kinds: `user`, `assistant`, `tool`, `result`; fields include stable byte-offset `id`, `timestamp`, `text`, `title`, `call_id`, `truncated`. Commands/results link by `call_id` when both are present in loaded pages; a result without its call is shown independently.
- `account`: returns `ssh_user` and `hostname` only. Does not read provider accounts, tokens, email addresses or plans.

History does not require a running Herdr session and never accepts a caller-selected filesystem path. A SHA-256 identifier resolves only through the approved transcript roots. A history record is not a terminal target. Only the existing live-agent operations can send input, with session/identity checks and mutation receipts unchanged.

Codex adapters read session_meta and response_item records; Claude adapters read user/assistant message blocks and the documented subagents layout. Private reasoning/system/developer records are omitted. Related upstream references: [Codex rollout reducer](https://github.com/openai/codex/blob/main/codex-rs/rollout-trace/src/reducer/thread.rs), [Claude subagent documentation](https://code.claude.com/docs/en/sub-agents). Local fixture and installed-version verification is required when schemas change.
