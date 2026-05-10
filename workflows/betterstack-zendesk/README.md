# Betterstack → Zendesk Incident Workflow

Three n8n workflows that mirror Betterstack uptime incidents into Zendesk tickets.

## Workflows

| File | n8n ID | Editor | Purpose |
|------|--------|--------|---------|
| `receiver.workflow.ts` | `hRNmqEHzL1597PVn` | [Open](https://twofifteen.app.n8n.cloud/workflow/hRNmqEHzL1597PVn) | Real-time webhook receiver |
| `poller.workflow.ts` | `rlZaQdC4uMnoOY5v` | [Open](https://twofifteen.app.n8n.cloud/workflow/rlZaQdC4uMnoOY5v) | 5-min polling reconciler |
| `resolve-subworkflow.workflow.ts` | `FXjwcoWpPhmv76ws` | [Open](https://twofifteen.app.n8n.cloud/workflow/FXjwcoWpPhmv76ws) | Shared resolution logic |

JSON snapshots committed to repo root: `betterstack-zendesk-receiver.json`, `betterstack-zendesk-poller.json`, `betterstack-zendesk-resolve.json`.

## Webhook URL

`https://twofifteen.app.n8n.cloud/webhook/betterstack-incident`

Configured in Betterstack: **Uptime → Integrations → Exporting data → Outgoing webhooks**.

## Auth

- **Incoming webhook**: `X-Webhook-Auth: Bearer <token>` header. Validated by the receiver's webhook node using the n8n credential `Betterstack Webhook Auth` (Header Auth type) via the node's native `headerAuth` authentication option.
  - Note: we initially planned to gate auth via an IF node comparing the header to `$env.BETTERSTACK_WEBHOOK_TOKEN`, but n8n Cloud does not expose `$env` in expressions, so we switched to the webhook node's built-in credential-based header auth instead.
- **Outbound to Betterstack API**: n8n credential `Betterstack Uptime API` (Header Auth, `Authorization: Bearer ...`). Credential ID: `TX7ufsOfAbxGftFw`.
- **Zendesk**: existing `Zendesk account` credential (shared with other workflows).

## Tag Vocabulary on Zendesk Tickets

| Tag | Meaning |
|---|---|
| `betterstack-incident-<id>` | Maps ticket to Betterstack incident. Permanent. |
| `betterstack-open` | Open + needs polling check. Removed at resolution. |
| `betterstack-resolved` | Idempotency sentinel. Permanent. |
| `betterstack-acked` | Idempotency sentinel for ack comment. Permanent. |
| `automated` | Marks bot-created tickets (existing convention). |
| `reopened` | Set when reopen-after-close creates a fresh ticket. |
| `network` | Side-effect of Category=Network custom field — Zendesk auto-mirrors dropdown values to the tags array. |

## Field Configuration

### On creation (started branch)

- **Group**: `System Administration` (ID `360021265172`)
- **Assignee**: `Robby Barnes` (user ID `387328728671`)
- **Requester**: `Better Stack` (user ID `26045726036621`, email `betterstack@215.tech`)
- **Priority**: `high`

### On resolution (resolve sub-workflow)

- **Type** (Zendesk system field): `incident`
- **Category** custom field (ID `360048770292`): `network` (displays as "Network")
- **Resolution comment public**: `true` (matches the existing Zapier zap behavior)

## Cutover

Replaced Zapier zap "<OLD_ZAP_NAME_TODO>" on `<CUTOVER_DATE_TODO>`. Zap left disabled (not deleted) for rollback.

> Currently pending — Task 4.2 (disable old Zapier zap) has not yet been completed by the user. Update the date and zap name above once cutover happens.

## Operational Notes

- **404 from Betterstack API during polling** = the incident was deleted on the Betterstack side. The poller strips `betterstack-open` from the ticket and posts an internal comment explaining what happened.
- **5xx from Betterstack** falls through silently to the "still-open" no-op branch; the ticket retains `betterstack-open` so the next poll cycle (every 5 min) retries naturally. Acceptable at our current incident volume.
- **24-hour-closed Zendesk tickets are immutable.** A reopen webhook arriving for a ticket that has already been auto-closed creates a fresh ticket tagged `reopened` with a comment linking to the original.
- **Ack-arriving-before-create is intentionally not queued.** If for any reason the `acknowledged` webhook arrives before the `started` webhook, we drop the ack-comment update and accept that the resulting ticket lacks the ack annotation. The `started` and `resolved` webhooks still fire and produce a complete ticket lifecycle.
- **Slack error notifications**: `<SLACK_CHANNEL_TODO>` (error-notification workflow is Task 5.3 — may be skipped depending on need).
- **Test tickets left in Zendesk for cleanup**: #35019, #35020, #35021.

## See Also

- Spec: `docs/superpowers/specs/2026-05-09-betterstack-zendesk-incident-workflow-design.md`
- Plan: `docs/superpowers/plans/2026-05-09-betterstack-zendesk-incident-workflow.md`
