# Configuration

The gateway reads one YAML file, by default `/config/config.yaml` (override with the
`CONFIG_PATH` environment variable). A fully commented example is in
[`config.example.yaml`](../config.example.yaml).

The file is validated on startup. Unknown keys, invalid values and missing environment
variables stop the container with a message naming the problem (exit code 2).

## Secrets

Write secrets as `${NAME}`; they are replaced with the environment variable `NAME`. With Docker
Compose, put them in `.env` (see [`.env.example`](../.env.example)). Every referenced variable
must be set and non-empty.

## `server`

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | number | `8080` | Port for REST (`/v1`), MCP (`/mcp`), `/health` and `/docs`. |
| `log_level` | string | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. Logs are JSON on stdout. |
| `data_dir` | string | `/data` | Directory for `gateway.sqlite`. Mount a volume here. |

## `mailboxes[]`

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Identifier (`a-z`, `0-9`, `_`, `-`). Used in logs and webhooks. Unique. |
| `address` | email | required | The mailbox address; used as `From` when sending. Unique. |
| `api_key` | string | required | Bearer token for this mailbox. At least 32 characters. Unique. |
| `imap` | object | required | `{ host, port, security }` of the incoming server. |
| `smtp` | object | required | `{ host, port, security }` of the outgoing server. |
| `username` | string | required | Login for IMAP and SMTP. |
| `password` | string | required | Password for IMAP and SMTP. |
| `allow_receive_from` | list | `[]` | Who the agent may receive mail from. |
| `allow_send_to` | list | `[]` | Who the agent may send mail and invites to. |
| `non_allowed_action` | `delete` \| `keep` | `delete` | What happens to mail from non-allowed senders. |
| `require_sender_auth` | boolean | `true` | Require a passing SPF/DKIM/DMARC result. |
| `allow_delete` | boolean | `false` | Let the agent move mail to Trash. |
| `max_sends_per_hour` | number | `30` | Sends (incl. invites) per rolling hour. `0` = unlimited. |
| `max_attachment_mb` | number | `15` | Max total attachment size per outgoing message. |
| `timezone` | string | `UTC` | IANA zone for event times given without an offset. |
| `poll_interval_seconds` | number | `300` | Safety-net poll interval (min 10). |
| `folders.sent` / `folders.trash` | string | auto | Override folder names. |
| `webhook.url` / `webhook.secret` | string | — | Optional webhook; secret at least 16 characters. |

### Ports and `security`

| Protocol | `security: tls` | `security: starttls` |
|---|---|---|
| IMAP | 993 | 143 |
| SMTP | 465 | 587 |

`security: none` disables encryption and is meant only for local test servers.

Example for a Plesk mailbox (IMAP 993, SMTP 465):

```yaml
imap: { host: mail.yourmailserver.eu, port: 993, security: tls }
smtp: { host: mail.yourmailserver.eu, port: 465, security: tls }
```

POP3 is not supported: it cannot mark mail as read or move it reliably.

### Allow lists

Each entry is either an exact address (`you@yourmailserver.eu`) or a whole domain
(`*@yourcompany.eu`). Domain entries match that exact domain only — `*@yourcompany.eu` does not
match `a@mail.yourcompany.eu`. Matching ignores case. An empty list allows nothing.

When sending, **every** recipient in `to`, `cc`, `bcc` (and every event attendee) must match
`allow_send_to`; otherwise the whole request is rejected with `recipient_not_allowed` and
nothing is sent.

### Non-allowed mail

The gateway checks every new message in INBOX. If the sender is not allowed (or fails sender
authentication):

- `delete` (default): the message is moved to the Trash folder. If the server has no Trash
  folder it is deleted permanently.
- `keep`: the message stays in INBOX.

In both cases the agent never sees it: it is excluded from lists, and reading it by id
returns `404 not_found`. Every filtered message is recorded in the audit log.

On the very first start (and whenever the server resets its UID numbering) the gateway takes
the current inbox as its starting point: existing mail is neither filtered nor reported via
webhook. Only mail arriving afterwards is processed. Existing mail from non-allowed senders
is still invisible to the agent.

### Sender authentication

Anyone can put any address into `From`. With `require_sender_auth: true` the gateway only
accepts a message if the top-most `Authentication-Results` header (added by your receiving
mail server) shows `dmarc=pass`, or — when there is no DMARC result — an aligned `dkim=pass`
or `spf=pass` for the sender's domain.

**Check that your server adds this header** before relying on it: open any received message's
source (in most mail clients: "Show original" / "View source") and look for
`Authentication-Results:`. If it is absent, set `require_sender_auth: false` — otherwise all
mail is filtered. The gateway logs a hint when it filters a message only because the header is
missing.

### Folders

`Sent` and `Trash` are detected via IMAP special-use flags, then by name. If no Sent folder
exists, one named `Sent` (or `folders.sent`) is created; a copy of every sent message is
stored there because many servers do not do this for SMTP.

### Webhook

See [api.md](api.md#webhooks) for the payload and signature.
