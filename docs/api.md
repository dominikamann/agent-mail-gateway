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
| `review_rejected` | 422 | The pre-send review stopped the message; `details.reviewer` is `rules`, `policy` or `llm`, `details.reasons` lists `{ rule, message }`. Nothing was sent. |
| `mailbox_unavailable` | 503 | The IMAP server is not reachable right now. |

## Mailbox

### `GET /v1/mailbox`

Also returns `now` (UTC) and `now_local` (in the mailbox time zone) so agents can resolve
"tomorrow at 14:00", and `review`: `{ rules, llm_review, policies: [{ rule, recipients? }] }` —
the checks outgoing mail must pass.

```json
{
  "address": "youragent@yourmailserver.eu",
  "allow_receive_from": ["you@yourmailserver.eu"],
  "allow_send_to": ["you@yourmailserver.eu"],
  "allow_delete": false,
  "max_sends_per_hour": 30,
  "max_attachment_mb": 15,
  "timezone": "Europe/Berlin",
  "now": "2026-10-03T09:30:00.000Z",
  "now_local": "Saturday, 3 October 2026 at 11:30 (Europe/Berlin)",
  "review": { "rules": "block", "llm_review": "off", "policies": [{ "rule": "Never share financial information." }] }
}
```

## Messages

### `GET /v1/messages`

Query: `unread` (`true`/`false`), `text` (words in subject, sender or body), `from`,
`subject`, `before` (like `since`), `since` (`2026-10-01` for the start of that day, or an ISO
date-time; without an offset it is read in the mailbox `timezone`), `limit` (1–50, default 20),
`cursor` (`next_cursor` from the previous page). Newest first; INBOX only. `since` compares
with the time the message **arrived** in the mailbox, not the sender's `Date` header, so a
delayed message is never skipped by an agent that polls with `since=<last poll>`.

Messages larger than 1 MB are listed without a `preview` (empty string) so that listing never
downloads big mails; `has_attachments` is still set. `read_message` always returns the full
message.

```json
{
  "messages": [
    {
      "id": "1712345678-42",
      "from": "you@yourmailserver.eu",
      "from_name": "Alex",
      "to": ["youragent@yourmailserver.eu"],
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

Returns the summary fields plus `message_id`, `reply_to`, `body_markdown`,
`attachments: [{ index, filename, content_type, size }]` and `invitation` — `null`, or the
calendar invitation contained in the message:

```json
"invitation": {
  "method": "REQUEST", "uid": "abc@partner.example", "title": "Planning",
  "start": "2026-10-10T12:00:00.000Z", "end": "2026-10-10T13:00:00.000Z", "all_day": false,
  "location": "Room 1", "description": null, "organizer": "x@partner.example",
  "attendees": [{ "email": "youragent@yourmailserver.eu", "status": "needs-action" }],
  "timezone_unknown": false
}
```

Marks the message as read unless `mark_read=false`.

### `POST /v1/messages/{id}/reply`

Body `{ "body_markdown": "…", "reply_all": false, "attachments": [] }`. Attachments everywhere
accept one of three forms:

```json
{ "filename": "notes.csv", "content_type": "text/csv", "content_text": "a,b\n1,2" }
{ "filename": "photo.jpg", "content_type": "image/jpeg", "content_base64": "…" }
{ "from_message": { "id": "1712345678-42", "index": 0 } }
```

`content_text` is for text files, `from_message` re-attaches a file from a received message
(the original file name and type are used unless given; calendar files cannot be re-attached).
At most 20 attachments per message; the size limit applies to their total. Replies to the sender
(or the `Reply-To` address); with `reply_all` also to everyone in To and Cc except the mailbox
itself. Subject (`Re: …`) and threading headers are set automatically. Same response and errors
as `POST /v1/messages`.

### `POST /v1/messages/{id}/forward`

Body `{ "to": ["…"], "cc": [], "bcc": [], "body_markdown": "optional note", "include_attachments": true }`.
Sends `Fwd: <subject>` with your note, a header block of the original and its text; attachments
are included unless `include_attachments` is false.

### `POST /v1/messages/{id}/rsvp`

Body `{ "response": "accept" | "decline" | "tentative", "comment": "optional" }`. Answers the
invitation in that message with a standard iCalendar reply to the organizer (who must be on
`allow_send_to`). `validation_error` if the message contains no invitation.

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
  "to": ["you@yourmailserver.eu"],
  "cc": [],
  "bcc": [],
  "subject": "Weekly numbers",
  "body_markdown": "Here they are:\n\n| Week | Value |\n|---|---|\n| 40 | 12 |",
  "attachments": [{ "filename": "numbers.csv", "content_type": "text/csv", "content_base64": "V2VlayxWYWx1ZQo0MCwxMgo=" }],
  "reply_to_id": "1712345678-42"
}
```

`reply_to_id` threads the reply (sets `In-Reply-To`/`References`, prefixes `Re:`).
Response: `{ "message_id": "<…@yourmailserver.eu>", "warnings": [] }`. The warning
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
  "attendees": ["you@yourmailserver.eu"]
}
```

Times may carry an offset (`2026-10-05T14:00:00+02:00`, `…Z`); without one they are read in
`timezone`, falling back to the mailbox `timezone`. The response contains the event `id`,
UTC `start`/`end`, `sequence` and `status`.

### `PATCH /v1/events/{id}`

Any subset of the fields above; `location` or `description_markdown` set to `null` removes it.
Changes to the same event are applied one after another. All attendees receive an updated invitation (the calendar
entry is updated in place); attendees removed from the list receive a cancellation.

### `DELETE /v1/events/{id}`

Sends a cancellation to all attendees.

### `GET /v1/events/{id}`

One event (with `start_local`/`end_local` in the event's time zone), including `responses`: answers received from attendees, e.g.
`{ "you@yourmailserver.eu": "accepted" }` (`accepted`, `declined`, `tentative`, …). Answers are
picked up automatically when the attendee's calendar replies. Only an attendee's own answer
counts (from their address, for the current version of the event); when the time changes, all
answers are cleared, and removed attendees' answers are dropped.

Time zones in received invitations: IANA names (`Europe/Berlin`) and the Windows names used by
Outlook/Exchange (`W. Europe Standard Time`) are understood. If a zone is unknown, times are
read as UTC and `timezone_unknown` is `true`.

### `GET /v1/events`

`{ "events": [ … ] }` — events created by this mailbox.

## Health

`GET /health`: without a key only `{ "status": "ok" | "degraded" }` (all mailboxes connected or not);
with a mailbox key, `status` covers only that mailbox and its state is included:
`{ "status": "ok", "mailboxes": [{ "name": "assistant", "state": "connected" }] }`.
States: `connected`, `reconnecting`, `error`, `stopped`.

## Webhooks

When an allowed message arrives and the mailbox has a `webhook`, the gateway sends:

```http
POST <webhook.url>
Content-Type: application/json
X-Gateway-Timestamp: 1790960000
X-Gateway-Signature: sha256=5d1f…
X-Webhook-Timestamp: 1790960000
X-Webhook-Signature-V2: 5d1f…

{"event":"message.received","event_type":"message.received","mailbox":"assistant","message":{"id":"1712345678-42","from":"you@yourmailserver.eu","subject":"Report","date":"2026-10-02T08:15:00.000Z","preview":"Please send…"}}
```

Both header pairs carry the same HMAC-SHA256 over `"<timestamp>.<raw body>"`:
`X-Gateway-*` with a `sha256=` prefix, and `X-Webhook-*` without prefix — the generic "V2"
scheme that Hermes Agent webhook routes verify natively (see [hermes.md](hermes.md)).

The full body is not included (only `preview`, the first 200 characters, empty for messages
over 1 MB) — fetch it with `GET /v1/messages/{id}` using the agent's key.
Any 2xx response counts as delivered; redirects are not followed (a 3xx counts as failed). Otherwise the gateway retries after 10 s, 1 min,
5 min, 15 min and 30 min, then gives up (the message is still available via the API).
Mailboxes are delivered independently: a slow or failing endpoint only delays its own mailbox.
Delivery is **at least once**: pending deliveries survive restarts, and if the gateway is
stopped in the middle of a delivery the same webhook can arrive twice. Use `message.id` to
ignore duplicates.

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
| `list_messages` | `text?`, `from?`, `subject?`, `since?`, `before?`, `unread?`, `limit?`, `cursor?` |
| `read_message` | `id`, `mark_read?` (default true) — includes `invitation` |
| `reply_message` | `id`, `body_markdown`, `reply_all?`, `attachments?` |
| `forward_message` | `id`, `to`, `cc?`, `bcc?`, `body_markdown?`, `include_attachments?` |
| `respond_to_invitation` | `id`, `response` (`accept` \| `decline` \| `tentative`), `comment?` |
| `get_attachment` | `id`, `index` — returns an embedded resource (base64) |
| `mark_message` | `id`, `unread` |
| `delete_message` | `id` |
| `send_message` | `to`, `cc?`, `bcc?`, `subject`, `body_markdown`, `attachments?`, `reply_to_id?` |
| `create_event` | `title`, `start`, `end`, `timezone?`, `location?`, `description_markdown?`, `attendees` |
| `update_event` | `id` plus any event field |
| `cancel_event` | `id` |
| `get_event` | `id` — includes attendee `responses` |
| `list_events` | — |
