# Betterstack → Zendesk Incident Workflow

**Date:** 2026-05-09
**Status:** Draft — pending user review
**Author:** Claude (with Robby Barnes)

## Problem

The current Zapier zap creates a Zendesk ticket when Betterstack opens an incident and is supposed to update + close that ticket when the incident resolves. In practice the resolution side fails intermittently — leaving open tickets that never get the resolution comment, downtime calculation, category, or status update. There is no fallback when Zapier misses the resolved-event webhook.

## Goals

1. Create a Zendesk ticket on every Betterstack incident.
2. On resolution, append a comment (matching the existing Zapier template) with monitor name, cause, start/resolve times, and total downtime; set the ticket to `solved`; assign category and type.
3. Tolerate missed webhooks. If the resolved-event webhook is dropped, the system reconciles within ~5 minutes via API polling.
4. Never duplicate tickets or comments. Webhook retries and webhook/poller races must be safe.

## Non-Goals

- Betterstack monitor configuration (out of scope; all setup happens in Betterstack UI).
- AI-driven categorization. Initial category/type assignment is deterministic.
- Slack alerting (existing channels handle that).
- Acknowledged-state behavior beyond a single internal comment.

## Architecture

Three n8n workflows. The poller and webhook receiver both call the same shared sub-workflow for resolution logic so the two paths cannot drift.

```
                       ┌──────────────────────────────────┐
   Betterstack         │  Workflow A: Webhook Receiver    │
   Outgoing Webhook ──▶│  (POST /webhook/                 │
                       │   betterstack-incident)          │
                       │                                  │
                       │  ┌─ verify bearer header ─┐      │
                       │  └─ branch by timestamps ─┘      │
                       │       │                          │
                       │       ├─ resolved-shape ─────────┼──┐
                       │       ├─ ack-shape (comment)     │  │
                       │       └─ started-shape ──────────┼──┼─▶ Zendesk
                       │             │                    │  │
                       │             ├─ ticket exists?    │  │
                       │             │   yes → reopen     │  │
                       │             │   no  → create     │  │
                       └──────────────────────────────────┘  │
                                                             │
                       ┌──────────────────────────────────┐  │
   Schedule (5 min) ──▶│  Workflow B: Polling Reconciler  │  │
                       │                                  │  │
                       │  Zendesk Search:                 │  │
                       │    tags:betterstack-open         │  │
                       │    status<solved                 │  │
                       │       │                          │  │
                       │       ▼                          │  │
                       │  For each ticket:                │  │
                       │    GET Betterstack incident      │  │
                       │    if Resolved → ─────────────────┼─┤
                       │    if 404      → strip tag       │  │
                       └──────────────────────────────────┘  │
                                                             ▼
                                ┌──────────────────────────────────┐
                                │  Sub-workflow: Resolve Ticket    │
                                │                                  │
                                │  Inputs: ticket_id, incident     │
                                │                                  │
                                │  1. Bail if betterstack-resolved │
                                │     tag already present          │
                                │  2. Compute downtime D/H/M/S     │
                                │  3. Format resolution comment    │
                                │  4. PUT Zendesk:                 │
                                │       status=solved              │
                                │       category, type             │
                                │       add comment                │
                                │       remove betterstack-open    │
                                │       add betterstack-resolved   │
                                └──────────────────────────────────┘
```

## State Model

State lives entirely on the Zendesk ticket as tags. No external storage.

| Tag | Set when | Cleared when | Purpose |
|---|---|---|---|
| `betterstack-incident-<id>` | Ticket created | Never | Maps ticket ↔ Betterstack incident. Survives reopen/close. |
| `betterstack-open` | Ticket created | Resolution sub-workflow | Marks tickets the poller should check. Absence = no work needed. |
| `betterstack-resolved` | End of resolve sub-workflow | Never | Idempotency sentinel. Sub-workflow no-ops if present. |
| `betterstack-acked` | Ack webhook handler | Never | Idempotency for ack comment (avoid double-comment on retry). |

The poller's Zendesk Search query is exactly: `tags:betterstack-open status<solved`. This returns at most a handful of rows in steady state — there's nothing to scan when no incidents are open.

## Components

### Workflow A — Webhook Receiver

**Trigger:** Webhook node, POST to `/webhook/betterstack-incident`.

**Auth:** First node after the trigger is an IF that compares `headers.x-webhook-auth` to a static bearer token stored in n8n credentials/env. Mismatch returns 401 and stops. (Betterstack has no HMAC — this is the only verification option, per their docs.)

**Routing:** A Switch node branches by inspecting `data.attributes`:

| Condition | Branch |
|---|---|
| `resolved_at != null` | Resolved |
| `acknowledged_at != null && resolved_at == null` | Acknowledged |
| `acknowledged_at == null && resolved_at == null` | Started |

We don't trust the `event` top-level field — Betterstack docs only document it for `comment` events. Timestamp inspection works for all five event types (started, ack, resolved, reopened, comment).

**Per-branch behavior:**

- **Started branch:**
  1. Search Zendesk for `tags:betterstack-incident-<id> status<closed`.
  2. If found → it's a reopen of a still-editable ticket. Set status=`open`, append comment "Incident reopened at `<started_at>`", remove `betterstack-resolved` tag if present, re-add `betterstack-open` tag.
  3. If not found → check if a closed ticket exists for this incident. If yes → create new ticket with `betterstack-incident-<id>` + `reopened` tags + comment linking to the prior ticket. If no → create a fresh ticket (the normal path).
  4. New-ticket fields:
     - **Subject:** `[Betterstack] <monitor name> is down`
     - **Description / first comment:** monitor URL, cause, started_at, link to Betterstack incident page (if discoverable from incident ID), screenshot URL if present.
     - **Priority:** `high` (placeholder — refine later per monitor).
     - **Tags:** `betterstack-incident-<id>`, `betterstack-open`, `automated`.
     - **Requester / group:** TODO — set in n8n UI before activating.

- **Acknowledged branch:**
  1. Search Zendesk by `betterstack-incident-<id>` tag, status<closed.
  2. If found and ticket lacks `betterstack-acked` tag → append internal comment "Incident acknowledged at `<acknowledged_at>` by `<acknowledged_by>`", add `betterstack-acked` tag.
  3. If not found → run the started-branch create flow first, then add ack comment. (Out-of-order webhook handling.)

- **Resolved branch:**
  1. Search Zendesk by `betterstack-incident-<id>` tag, status<closed.
  2. If found → call `Resolve Ticket` sub-workflow with `ticket_id` and the webhook payload's incident data.
  3. If not found → call the started-branch create flow but pass `pre-resolve=true` so it creates an already-solved ticket with the resolution comment included.

### Workflow B — Polling Reconciler

**Trigger:** Schedule trigger, every 5 minutes.

**Steps:**
1. Zendesk Search: `tags:betterstack-open status<solved`. Return ticket IDs and the `betterstack-incident-<id>` tag from each.
2. Split in batches.
3. For each ticket:
   - Extract incident ID from the tag.
   - HTTP Request: `GET https://uptime.betterstack.com/api/v3/incidents/<id>` with `Authorization: Bearer <token>` from credentials.
   - On 200 + `data.attributes.status == "Resolved"` → call `Resolve Ticket` sub-workflow.
   - On 200 + status anything else → no-op, leave for next poll cycle.
   - On 404 → incident deleted on Betterstack side. Append comment "Underlying Betterstack incident no longer exists; clearing automation tag.", remove `betterstack-open` tag.
   - On 5xx / network error → log and continue to next ticket. The 5-minute cadence will retry naturally.

**Rate limiting:** Betterstack does not publish a rate limit. Steady-state load is one Zendesk Search + N Betterstack GETs per 5 minutes, where N is the number of currently-open Betterstack-originated tickets. Realistic N is 0–5.

### Sub-workflow — Resolve Ticket

**Trigger:** Execute Workflow Trigger.

**Inputs:** `zendesk_ticket_id`, `incident` (the full `data.attributes` object — comes either from the webhook payload or from the polling Betterstack API response, both have the same shape).

**Steps:**
1. Get the current Zendesk ticket. If it already has tag `betterstack-resolved` → return early (idempotency sentinel).
2. Compute downtime as `resolved_at - started_at` in milliseconds; break into D/H/M/S using a Code node.
3. Format the resolution comment using the Zapier-compatible template:
   ```
   Status - resolved

   Title of the failing monitor: <name>
   Cause of the incident: <cause or "Not specified">
   ID: <incident_id>

   Start Time - <started_at, formatted "21 Oct 2024 at 10:09pm UTC">
   Resolution Time - <resolved_at, formatted same>

   Total Outage Time - <D> Days, <H> Hours, <M> Minutes, <S> Seconds
   ```
4. Update the Zendesk ticket in a single API call:
   - `status: solved`
   - `comment.body: <resolution comment>`, `comment.public: true` (matching the Zapier behavior — confirm this with user)
   - `tags`: existing tags minus `betterstack-open`, plus `betterstack-resolved`
   - `custom_fields`: category and type — TODO, populate before activating

If any step fails, the workflow's Error Trigger handler posts to Slack with the ticket ID and incident ID. Sub-workflow does NOT mark `betterstack-resolved` if the Zendesk update failed — the next poll cycle will retry.

## Idempotency Model

Every state transition checks a sentinel tag before acting and sets it after success:

- `betterstack-resolved` — gates the resolve sub-workflow. Set last, after the Zendesk update succeeds.
- `betterstack-acked` — gates the ack-comment branch.
- For initial create: the `betterstack-incident-<id>` tag itself is the idempotency check (we always search by it before creating).

This makes the system safe under:
- Webhook retries from Betterstack (no HMAC means we can't detect "same delivery" but the tag check catches it anyway).
- Webhook + poller racing for the same resolution (whichever finishes first sets the sentinel; the loser sees it and bails).
- Out-of-order webhooks (resolve-before-create promotes to "create-as-solved").

## Error Handling

- Each workflow has an n8n **Error Workflow** attached. On unhandled error, posts to a Slack channel with workflow name, execution ID, and error message.
- Inside the workflows, lookups that legitimately return zero rows (e.g., ack arriving before create) are handled with IF nodes, not exceptions.
- The polling workflow uses `Continue On Fail` per-iteration so one bad incident lookup doesn't kill the whole cycle.
- All Betterstack API calls use n8n's built-in retry: 3 attempts, exponential backoff. (HTTP Request node setting.)

## Auth & Secrets

| Secret | Storage | Used by |
|---|---|---|
| Zendesk API token | n8n credentials (existing "Zendesk account") | Both workflows + sub-workflow |
| Betterstack Uptime API token | n8n credentials (new "Betterstack Uptime API" Header Auth credential) | Polling workflow |
| Webhook bearer token (incoming auth) | n8n env var `BETTERSTACK_WEBHOOK_TOKEN` | Webhook receiver |

The webhook bearer token is configured on the Betterstack side as a custom header (`X-Webhook-Auth: Bearer <token>`) when creating the outgoing webhook integration. Same token compared in n8n's first IF node.

## Setup Checklist

**In Zendesk:**
1. (Optional) Create custom fields for category and type if they don't exist; capture their IDs.
2. Decide group + requester for auto-created tickets; capture IDs.

**In Betterstack:**
1. Generate Uptime API token at `Settings → API tokens` → "Uptime API token" scoped to the team.
2. Create outgoing webhook integration: `Uptime → Integrations → Exporting data → Outgoing webhooks → Configure`.
   - Type: **Incident**
   - Webhook URL: `https://twofifteen.app.n8n.cloud/webhook/betterstack-incident`
   - Triggers: enable `on_incident_started`, `on_incident_acknowledged`, `on_incident_resolved`, `on_incident_reopened`. Leave `on_incident_comment` off (we don't want comment events).
   - Custom headers: `X-Webhook-Auth: Bearer <generated-token>`

**In n8n:**
1. Add credential: Betterstack Uptime API (Header Auth, `Authorization: Bearer <api-token>`).
2. Set env var `BETTERSTACK_WEBHOOK_TOKEN` to the value used in Betterstack's custom header.
3. Deploy three workflows: receiver, poller, resolve sub-workflow.
4. Configure the resolve sub-workflow's category/type field IDs and the receiver's group/requester before activating.
5. Activate receiver first (test with a Betterstack manual trigger), then poller.

## Open Questions / TODOs

These are deliberately deferred — to be filled in during implementation or in a follow-up:

- Specific Zendesk **category** and **type** custom field IDs and their values.
- Group and requester for auto-created tickets.
- Whether the resolution comment should be public (Zapier zap appears to use a public comment; confirm).
- Whether to migrate from per-monitor priority=`high` to a per-monitor mapping (e.g., production monitors → urgent, staging → normal). Punt to v2.
- Slack channel for error notifications.
- Whether to swap the polling Zendesk Search for an incremental "tickets updated since last poll" query if ticket volume grows.

## Future Enhancements (Not in Scope)

- Bulk Betterstack lookup: `GET /incidents?resolved=false` once per poll instead of per-ticket.
- Incident grouping awareness — a single Zendesk ticket per group instead of per incident.
- Auto-discovery of the Betterstack incident dashboard URL (currently we'd hardcode the format `https://uptime.betterstack.com/team/<team>/incidents/<id>` if known).

---

**References**

- Betterstack outgoing webhooks: https://betterstack.com/docs/uptime/webhooks
- Betterstack outgoing webhook config API (payload templates): https://betterstack.com/docs/uptime/api/create-outgoing-webhook-integration
- Betterstack get-single-incident API: https://betterstack.com/docs/uptime/api/list-a-single-incident
- Betterstack list-incidents API: https://betterstack.com/docs/uptime/api/list-all-incidents
- Betterstack incident status field reference: https://betterstack.com/docs/uptime/api/incidents-api-response-params
- Betterstack incident resolution behavior: https://betterstack.com/docs/uptime/resolving-an-incident
- Existing Zapier zap resolution comment template (screenshot in conversation 2026-05-09)
