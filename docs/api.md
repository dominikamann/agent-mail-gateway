# REST API, webhooks and MCP

All `/v1` routes require `Authorization: Bearer <api_key>`. The key determines the mailbox;
mailbox names never appear in URLs. Interactive OpenAPI docs are served at `/docs`
(JSON at `/docs/json`).

## Errors

Every error has the same shape:

```json
{ "error": "recipient_not_allowed", "message": "One or more recipients are not allowed", "details": { "addresses": ["x@example.com"] } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing or unknown API key. |
| `validation_error` | 400 | Request does not match the schema (`details.issues`). |
| `not_found` | 404 | Unknown id — or a message from a non-allowed sender. |
| `recipient_not_allowed` | 403 | `details.addresses` lists recipients outside `allow_send_to`. |
| `delete_not_allowed` | 403 | `allow_delete` is false. |
| `attachment_too_large` | 413 | Attachments exceed `max_attachment_mb`. |
| `rate_limited` | 429 | `max_sends_per_hour` reached; see `Retry-After` and `details.retry_after_seconds`. |
| `send_failed` | 502 | The SMTP server rejected the message. Nothing was sent. |
| `mailbox_unavailable` | 503 | The IMAP server is not reachable right now. |

## Mailbox

### `GET /v1/mailbox`

```json
{
  "address": "agent@example.com",
  "allow_receive_from": ["you@example.net"],
  "allow_send_to": ["you@example.net"],
  "allow_delete": false,
  "max_sends_per_hour": 30,
  "max_attachment_mb": 15,
  "timezone": "Europe/Berlin"
}
```

## Messages

### `GET /v1/messages`

Query: `unread` (`true`/`false`), `since` (`2026-10-01` for the start of that day, or an ISO
date-time; without an offset it is read in the mailbox `timezone`), `limit` (1–50, default 20),
`cursor` (`next_cursor` from the previous page). Newest first; INBOX only.

```json
{
  "messages": [
    {
      "id": "1712345678-42",
      "from": "you@example.net",
      "from_name": "Alex",
      "to": ["agent@example.com"],
      "cc": [],
      "subject": "Report",
      "date": "2026-10-02T08:15:00.000Z",
      "preview": "Please send me the **weekly** numbers…",
      "unread": true,
      "has_attachments": false
    }
  ],
  "next_cursor": null
}
```

### `GET /v1/messages/{id}?mark_read=true`

Returns the summary fields plus `message_id`, `body_markdown` and
`attachments: [{ index, filename, content_type, size }]`. Marks the message as read unless
`mark_read=false`.

### `GET /v1/messages/{id}/attachments/{index}`

Returns the raw file with its content type, served with `Content-Disposition: attachment`,
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` so that files cannot
run in a browser.

### `PATCH /v1/messages/{id}`

Body `{ "unread": true }` or `{ "unread": false }`.

### `DELETE /v1/messages/{id}`

Moves the message to Trash. Requires `allow_delete: true`.

### `POST /v1/messages`

```json
{
  "to": ["you@example.net"],
  "cc": [],
  "bcc": [],
  "subject": "Weekly numbers",
  "body_markdown": "Here they are:\n\n| Week | Value |\n|---|---|\n| 40 | 12 |",
  "attachments": [{ "filename": "numbers.csv", "content_type": "text/csv", "content_base64": "V2VlayxWYWx1ZQo0MCwxMgo=" }],
  "reply_to_id": "1712345678-42"
}
```

`reply_to_id` threads the reply (sets `In-Reply-To`/`References`, prefixes `Re:`).
Response: `{ "message_id": "<…@example.com>", "warnings": [] }`. The warning
`copy_to_sent_failed` means the message was sent but could not be stored in Sent.

## Calendar events

### `POST /v1/events` → `201`

```json
{
  "title": "Review",
  "start": "2026-10-05T14:00",
  "end": "2026-10-05T15:00",
  "timezone": "Europe/Berlin",
  "location": "Office",
  "description_markdown": "Agenda: …",
  "attendees": ["you@example.net"]
}
```

Times may carry an offset (`2026-10-05T14:00:00+02:00`, `…Z`); without one they are read in
`timezone`, falling back to the mailbox `timezone`. The response contains the event `id`,
UTC `start`/`end`, `sequence` and `status`.

### `PATCH /v1/events/{id}`

Any subset of the fields above. All attendees receive an updated invitation (the calendar
entry is updated in place); attendees removed from the list receive a cancellation.

### `DELETE /v1/events/{id}`

Sends a cancellation to all attendees.

### `GET /v1/events`

`{ "events": [ … ] }` — events created by this mailbox.

## Health

`GET /health` (no key): `{ "status": "ok" | "degraded", "mailboxes": [{ "name": "ole", "state": "connected" }] }`.
States: `connected`, `reconnecting`, `error`, `stopped`.

## Webhooks

When an allowed message arrives and the mailbox has a `webhook`, the gateway sends:

```http
POST <webhook.url>
Content-Type: application/json
X-Gateway-Timestamp: 1790960000
X-Gateway-Signature: sha256=5d1f…

{"event":"message.received","mailbox":"assistant","message":{"id":"1712345678-42","from":"you@example.net","subject":"Report","date":"2026-10-02T08:15:00.000Z","preview":"Please send…"}}
```

The body is not included — fetch it with `GET /v1/messages/{id}` using the agent's key.
Any 2xx response counts as delivered. Otherwise the gateway retries after 10 s, 1 min,
5 min, 15 min and 30 min, then gives up (the message is still available via the API). Each
message is delivered successfully at most once, also across restarts.

Verify the signature: HMAC-SHA256 over `"<timestamp>.<raw body>"` with the webhook secret.

Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, timestamp, rawBody, signature) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

Python:

```python
import hashlib, hmac

def verify(secret: str, timestamp: str, raw_body: bytes, signature: str) -> bool:
    mac = hmac.new(secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256)
    return hmac.compare_digest("sha256=" + mac.hexdigest(), signature)
```

Also reject timestamps older than a few minutes to prevent replays.

## MCP

Endpoint: `POST /mcp` (Streamable HTTP, stateless), header `Authorization: Bearer <api_key>`.
Tool results are JSON text; errors come back with `isError: true` and the same error body as
REST.

| Tool | Arguments |
|---|---|
| `get_mailbox_info` | — |
| `list_messages` | `unread?`, `since?`, `limit?`, `cursor?` |
| `read_message` | `id`, `mark_read?` (default true) |
| `get_attachment` | `id`, `index` — returns an embedded resource (base64) |
| `mark_message` | `id`, `unread` |
| `delete_message` | `id` |
| `send_message` | `to`, `cc?`, `bcc?`, `subject`, `body_markdown`, `attachments?`, `reply_to_id?` |
| `create_event` | `title`, `start`, `end`, `timezone?`, `location?`, `description_markdown?`, `attendees` |
| `update_event` | `id` plus any event field |
| `cancel_event` | `id` |
| `list_events` | — |
