# Protocol 1

Transport: SSH exec `python3 <quoted-content-addressed-bridge-path>`. UTF-8 JSON line on stdin, JSON object on stdout. No PTY. Maximum input 65536 bytes; maximum prompt 16000 UTF-8 bytes. Herdr subprocess timeout 20 seconds; phone response timeout 35 seconds.

Request fields:

| Field | Meaning |
|---|---|
| `v` | Integer `1` |
| `op` | `hello`, `sessions`, `agents`, `read`, `prompt`, `key` |
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
