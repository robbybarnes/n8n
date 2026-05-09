# Betterstack → Zendesk Incident Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unreliable Zapier Betterstack→Zendesk zap with three n8n workflows (webhook receiver + polling reconciler + shared resolve sub-workflow) that survive missed webhooks and never duplicate state.

**Architecture:** Tag-based state on Zendesk tickets. Sentinel tags (`betterstack-resolved`, `betterstack-acked`) gate every mutation for idempotency. Webhook receiver branches by inspecting `data.attributes` timestamps. Polling reconciler runs every 5 min, scoped to `tags:betterstack-open status<solved`. Both real-time and polling paths call the same resolve sub-workflow.

**Tech Stack:** n8n Cloud + n8n Workflow SDK (via `mcp__n8n-mcp__create_workflow_from_code`). HTTP Request, Webhook, Schedule Trigger, Switch, IF, Code, Execute Workflow, Zendesk nodes. Betterstack Uptime API v3.

**Spec:** `docs/superpowers/specs/2026-05-09-betterstack-zendesk-incident-workflow-design.md`

---

## File Structure

New files committed to the repo:

```
workflows/
└── betterstack-zendesk/
    ├── README.md                       Operational notes + setup checklist
    ├── resolve-subworkflow.workflow.ts SDK source for the resolve sub-workflow
    ├── receiver.workflow.ts            SDK source for the webhook receiver
    └── poller.workflow.ts              SDK source for the polling reconciler

betterstack-zendesk-resolve.json        JSON export (backup; matches existing convention)
betterstack-zendesk-receiver.json       JSON export
betterstack-zendesk-poller.json         JSON export
```

`CLAUDE.md` workflow registry table also updated with the three new workflows.

---

## Phase 0: Discovery & Setup

### Task 0.1: Read the n8n Workflow SDK reference

**Files:** none (read-only research)

- [ ] **Step 1: Fetch the SDK reference**

Run via the n8n-mcp tool:
```
mcp__n8n-mcp__get_sdk_reference()
```

Expected: full SDK reference document. Note the patterns for: defining a Workflow object, declaring nodes, declaring connections (especially trigger → first node), Execute Workflow Trigger inputs, and how Code-node JS is embedded.

- [ ] **Step 2: Fetch SDK design + guidelines sections**

```
mcp__n8n-mcp__get_sdk_reference(section: "guidelines")
mcp__n8n-mcp__get_sdk_reference(section: "design")
```

Expected: coding-style and design conventions to follow.

- [ ] **Step 3: Discover all node types we'll use**

Run in parallel:
```
mcp__n8n-mcp__search_nodes(query: "webhook")
mcp__n8n-mcp__search_nodes(query: "schedule trigger")
mcp__n8n-mcp__search_nodes(query: "execute workflow")
mcp__n8n-mcp__search_nodes(query: "execute workflow trigger")
mcp__n8n-mcp__search_nodes(query: "switch")
mcp__n8n-mcp__search_nodes(query: "if")
mcp__n8n-mcp__search_nodes(query: "code")
mcp__n8n-mcp__search_nodes(query: "zendesk")
mcp__n8n-mcp__search_nodes(query: "http request")
mcp__n8n-mcp__search_nodes(query: "set")
mcp__n8n-mcp__search_nodes(query: "split in batches")
```

Note the exact `nodeId` strings (e.g. `n8n-nodes-base.webhook`, `n8n-nodes-base.zendesk`). These get passed to `get_node_types`.

- [ ] **Step 4: Get type definitions for every node ID identified**

```
mcp__n8n-mcp__get_node_types(nodeIds: [<list of every node ID from Step 3>])
```

Save the response. **Do not skip — guessing parameter names creates invalid workflows.**

- [ ] **Step 5: No commit (research only)**

### Task 0.2: Capture user-supplied configuration

**Files:** none (information gathering)

- [ ] **Step 1: Ask the user for the following values and record them in your scratchpad. Do not commit secrets to the repo.**

Required:
1. Betterstack Uptime API token (Bearer). User generates at `Settings → API tokens` → "Uptime API token" scoped to their Uptime team.
2. Webhook bearer token. Generate a fresh random string with `openssl rand -hex 32`. Will be stored in n8n env var `BETTERSTACK_WEBHOOK_TOKEN` AND configured as the value of a `X-Webhook-Auth: Bearer <token>` header on the Betterstack outgoing webhook integration.
3. Zendesk **group ID** for auto-created Betterstack tickets.
4. Zendesk **requester email** (or user ID) for auto-created tickets — typically a service-account user like `betterstack@215.tech`.
5. Zendesk **category** custom field ID + the value to set on resolution.
6. Zendesk **type** custom field ID + the value to set on resolution.
7. Zendesk **priority** to use on creation (default `high`).
8. Slack channel ID for the error-notification workflow (for failures).
9. Whether the resolution comment should be `public: true` (matches Zapier) or `public: false`.

- [ ] **Step 2: No commit**

### Task 0.3: Set up n8n credentials and env var

**Files:** none (n8n UI / API)

- [ ] **Step 1: Create the Betterstack credential in n8n**

In the n8n UI at https://twofifteen.app.n8n.cloud, create a new credential of type **"Header Auth"** named **`Betterstack Uptime API`**:
- Name: `Authorization`
- Value: `Bearer <api-token-from-Task-0.2-step-1>`

Capture the credential's ID for use in the HTTP Request nodes.

- [ ] **Step 2: Set the webhook bearer env var**

In n8n Cloud at `Settings → Variables` (or environment variables), add:
- Key: `BETTERSTACK_WEBHOOK_TOKEN`
- Value: `<token-from-Task-0.2-step-2>`

- [ ] **Step 3: Verify Zendesk credential exists**

Check that the existing credential named `Zendesk account` works — this is the same one used by `zendesk-ai-priority-classifier-webhook.json`. No changes needed.

- [ ] **Step 4: Commit (no code change yet, but mark setup done)**

```bash
git status   # expect clean
```

If the user has provided field IDs and they should be tracked (non-secret), append them to `workflows/betterstack-zendesk/README.md` in Task 5.1. Skip commit here.

---

## Phase 1: Resolve Sub-workflow

This sub-workflow is the dependency for both the receiver and the poller. Build it first so its workflow ID can be referenced.

### Task 1.1: Author the resolve sub-workflow code

**Files:**
- Create: `workflows/betterstack-zendesk/resolve-subworkflow.workflow.ts`

- [ ] **Step 1: Write the workflow source using the SDK**

Use the patterns from Task 0.1's SDK reference. The workflow must contain:

1. **Execute Workflow Trigger** — declares two inputs:
   - `zendesk_ticket_id` (string)
   - `incident` (object) — full `data.attributes` from Betterstack (whether sourced from webhook or API).

2. **Get Zendesk Ticket** node (`n8n-nodes-base.zendesk`):
   - resource=ticket, operation=get
   - ticketId=`{{ $json.zendesk_ticket_id }}`
   - Credential: `Zendesk account`

3. **IF** node "Already Resolved?":
   - Condition: `{{ $json.tags.includes('betterstack-resolved') }}` equals `true`
   - TRUE branch → **NoOp** node (early return)
   - FALSE branch continues

4. **Code** node "Compute Downtime + Format Comment" (JavaScript):
   ```javascript
   const ticket = $('Get Zendesk Ticket').item.json;
   const incident = $('Execute Workflow Trigger').item.json.incident;

   const startedAt = new Date(incident.started_at);
   const resolvedAt = new Date(incident.resolved_at);
   const diffMs = resolvedAt - startedAt;
   const days = Math.floor(diffMs / 86400000);
   const hours = Math.floor((diffMs % 86400000) / 3600000);
   const minutes = Math.floor((diffMs % 3600000) / 60000);
   const seconds = Math.floor((diffMs % 60000) / 1000);

   const fmt = (d) => d.toLocaleString('en-GB', {
     day: 'numeric', month: 'short', year: 'numeric',
     hour: 'numeric', minute: '2-digit', hour12: true,
     timeZone: 'UTC',
   }).replace(',', ' at') + ' UTC';

   const cause = incident.cause || 'Not specified';
   const incidentId = $('Execute Workflow Trigger').item.json.incident_id
     || $('Execute Workflow Trigger').item.json.zendesk_ticket_id;

   const comment = [
     `Status - resolved`,
     ``,
     `Title of the failing monitor: ${incident.name}`,
     `Cause of the incident: ${cause}`,
     `ID: ${incidentId}`,
     ``,
     `Start Time - ${fmt(startedAt)}`,
     `Resolution Time - ${fmt(resolvedAt)}`,
     ``,
     `Total Outage Time - ${days} Days, ${hours} Hours, ${minutes} Minutes, ${seconds} Seconds`,
   ].join('\n');

   const newTags = ticket.tags
     .filter((t) => t !== 'betterstack-open')
     .concat(['betterstack-resolved']);

   return [{ json: { comment, newTags, ticket_id: ticket.id } }];
   ```

5. **Update Zendesk Ticket** node (`n8n-nodes-base.zendesk`):
   - resource=ticket, operation=update
   - ticketId=`{{ $json.ticket_id }}`
   - updateFieldsJson:
     ```
     {{ JSON.stringify({
       status: 'solved',
       tags: $json.newTags,
       comment: { body: $json.comment, public: <PUBLIC_FROM_TASK_0.2_STEP_9> },
       custom_fields: [
         { id: <CATEGORY_FIELD_ID>, value: '<CATEGORY_VALUE>' },
         { id: <TYPE_FIELD_ID>, value: '<TYPE_VALUE>' }
       ]
     }) }}
     ```
   - Credential: `Zendesk account`

6. **Sticky Note** documenting the sub-workflow's purpose, idempotency model, and inputs.

**The `incident_id` field on the Execute Workflow Trigger input** — also pass this from the callers so the resolution comment shows the Betterstack incident ID (the existing Zapier zap does this). Update the trigger input schema to include `incident_id` (string).

- [ ] **Step 2: Validate the workflow code**

```
mcp__n8n-mcp__validate_workflow(code: <full TypeScript source>)
```

Expected: `valid: true`. If errors, fix the code and re-validate. Common fixes: missing required parameter on a node, wrong type for a field, expression syntax error.

- [ ] **Step 3: Commit the validated source**

```bash
git add workflows/betterstack-zendesk/resolve-subworkflow.workflow.ts
git commit -m "feat(betterstack): resolve sub-workflow source"
```

### Task 1.2: Create the resolve sub-workflow in n8n

**Files:** none (deploys to n8n cloud)

- [ ] **Step 1: Create via MCP**

```
mcp__n8n-mcp__create_workflow_from_code({
  code: <validated source from Task 1.1>,
  description: "Shared resolution logic for Betterstack incidents. Called by the webhook receiver and the polling reconciler. Idempotent via betterstack-resolved sentinel tag."
})
```

Capture the returned workflow ID. **Save it as `RESOLVE_SUBWORKFLOW_ID`** — needed by Tasks 2.x and 3.x.

- [ ] **Step 2: Verify the workflow appears in n8n**

```
mcp__n8n-mcp__search_workflows(query: "Betterstack Resolve")
```

Expected: returns the new workflow with `active: false`.

- [ ] **Step 3: Export JSON snapshot for git**

```python
python3 -c "
import json, urllib.request
url = 'https://twofifteen.app.n8n.cloud/api/v1/workflows/<RESOLVE_SUBWORKFLOW_ID>'
req = urllib.request.Request(url)
req.add_header('X-N8N-API-KEY', open('.env').read().split('N8N_API_KEY=')[1].split('\n')[0])
data = json.loads(urllib.request.urlopen(req).read())
with open('betterstack-zendesk-resolve.json', 'w') as f:
    json.dump(data, f, indent=2)
"
```

- [ ] **Step 4: Commit JSON snapshot**

```bash
git add betterstack-zendesk-resolve.json
git commit -m "feat(betterstack): deploy resolve sub-workflow (id: <RESOLVE_SUBWORKFLOW_ID>)"
```

### Task 1.3: Smoke-test the resolve sub-workflow

**Files:** none (uses n8n test execution)

- [ ] **Step 1: Create a test Zendesk ticket manually**

In Zendesk, create a ticket with:
- Subject: `[TEST] Betterstack resolve smoke test`
- Tags: `betterstack-incident-test-12345`, `betterstack-open`, `automated`, `test`
- Status: `open`

Capture the ticket ID (call it `TEST_TICKET_ID`).

- [ ] **Step 2: Pin synthetic input data on the Execute Workflow Trigger**

```
mcp__n8n-mcp__prepare_test_pin_data({
  workflowId: "<RESOLVE_SUBWORKFLOW_ID>",
  nodeName: "Execute Workflow Trigger",
  data: {
    zendesk_ticket_id: "<TEST_TICKET_ID>",
    incident_id: "test-12345",
    incident: {
      name: "Test Monitor",
      url: "https://example.com",
      cause: "Synthetic test cause",
      started_at: "2026-05-09T10:00:00Z",
      resolved_at: "2026-05-09T10:05:30Z"
    }
  }
})
```

- [ ] **Step 3: Run the sub-workflow**

```
mcp__n8n-mcp__test_workflow({ workflowId: "<RESOLVE_SUBWORKFLOW_ID>" })
```

Expected: execution succeeds. Capture execution ID.

- [ ] **Step 4: Verify the test ticket in Zendesk**

Open `TEST_TICKET_ID` in Zendesk. Confirm:
- Status is `solved`
- A new comment is present with the formatted resolution text and "Total Outage Time - 0 Days, 0 Hours, 5 Minutes, 30 Seconds"
- Tags include `betterstack-resolved`, do NOT include `betterstack-open`

If any assertion fails: read the execution log via `mcp__n8n-mcp__get_execution(<id>)`, fix the workflow with `mcp__n8n-mcp__update_workflow`, re-export JSON, commit fix, re-test.

- [ ] **Step 5: Run idempotency test**

Re-run the same test (Step 3). Verify the ticket has only ONE resolution comment (not two), and the run hits the early-return NoOp branch.

- [ ] **Step 6: Commit any fixes from Step 4**

```bash
git add workflows/betterstack-zendesk/resolve-subworkflow.workflow.ts betterstack-zendesk-resolve.json
git commit -m "fix(betterstack): <description of fix>"
```

If no fixes needed, skip commit.

---

## Phase 2: Webhook Receiver

### Task 2.1: Author the webhook receiver

**Files:**
- Create: `workflows/betterstack-zendesk/receiver.workflow.ts`

- [ ] **Step 1: Write the workflow source**

Required nodes and structure:

1. **Webhook trigger** (`n8n-nodes-base.webhook`):
   - HTTP method: POST
   - Path: `betterstack-incident`
   - Response mode: `lastNode` (returns the final node's output)
   - Response code: 200 by default

2. **IF node "Verify Bearer Token"**:
   - Condition: `{{ $json.headers['x-webhook-auth'] }}` equals `Bearer {{ $env.BETTERSTACK_WEBHOOK_TOKEN }}`
   - FALSE branch → **Respond to Webhook** node with statusCode 401, body `{"error":"unauthorized"}`. End of branch.
   - TRUE branch continues.

3. **Switch node "Branch by Event"** with three outputs:
   - Output 0 ("resolved"): `{{ $json.body.data.attributes.resolved_at }}` is not empty
   - Output 1 ("acknowledged"): `{{ $json.body.data.attributes.acknowledged_at }}` is not empty AND `{{ $json.body.data.attributes.resolved_at }}` is empty
   - Output 2 ("started"): `{{ $json.body.data.attributes.acknowledged_at }}` is empty AND `{{ $json.body.data.attributes.resolved_at }}` is empty

4. **Sticky note** explaining the timestamp-discriminator pattern (Betterstack only documents `event` for comment events).

5. The three branches each terminate in branch-specific nodes — built in subsequent tasks.

- [ ] **Step 2: Validate the workflow code**

```
mcp__n8n-mcp__validate_workflow(code: <source>)
```

Expected: `valid: true`. Switch node may complain about missing default output — set `fallbackOutput: "none"` to drop unrecognized payloads silently (or route to a logging node).

- [ ] **Step 3: Commit**

```bash
git add workflows/betterstack-zendesk/receiver.workflow.ts
git commit -m "feat(betterstack): receiver scaffolding (auth + branching)"
```

### Task 2.2: Build the resolved branch

**Files:**
- Modify: `workflows/betterstack-zendesk/receiver.workflow.ts`

- [ ] **Step 1: Append nodes to the resolved branch**

Add to the workflow code:

1. **Zendesk Search "Find Open Ticket"** (`n8n-nodes-base.zendesk`):
   - resource=ticket, operation=getAll, returnAll=false, limit=1
   - filters/options:
     - query: `{{ "tags:betterstack-incident-" + $('Webhook').item.json.body.data.id + " status<closed" }}`
   - Credential: `Zendesk account`

2. **IF node "Ticket Found?"**:
   - Condition: `{{ $json }}` is not empty (or check `$items('Find Open Ticket').length > 0`)

3. **TRUE branch (ticket exists)**: **Execute Workflow** node calling `<RESOLVE_SUBWORKFLOW_ID>` with inputs:
   - zendesk_ticket_id: `{{ $('Find Open Ticket').item.json.id }}`
   - incident_id: `{{ $('Webhook').item.json.body.data.id }}`
   - incident: `{{ $('Webhook').item.json.body.data.attributes }}`

4. **FALSE branch (no open ticket — resolved arrived without create)**:
   - **Zendesk Create Ticket** with status=`solved`, the resolution comment as initial comment, tags include `betterstack-incident-<id>` + `betterstack-resolved` (NO `betterstack-open` since it's already resolved).
   - Computes the same resolution-comment template inline with a Code node (DRY warning: this duplicates the sub-workflow's formatter — extract to a shared Code-node template if practical, otherwise document the duplication explicitly in a Sticky Note).

- [ ] **Step 2: Validate**

```
mcp__n8n-mcp__validate_workflow(code: <updated source>)
```

Expected: `valid: true`.

- [ ] **Step 3: Commit**

```bash
git add workflows/betterstack-zendesk/receiver.workflow.ts
git commit -m "feat(betterstack): receiver resolved branch"
```

### Task 2.3: Build the acknowledged branch

**Files:**
- Modify: `workflows/betterstack-zendesk/receiver.workflow.ts`

- [ ] **Step 1: Append nodes**

1. **Zendesk Search "Find Open Ticket (Ack)"** (`n8n-nodes-base.zendesk`):
   - resource=ticket, operation=getAll, returnAll=false, limit=1
   - filters/options:
     - query: `{{ "tags:betterstack-incident-" + $('Webhook').item.json.body.data.id + " status<closed" }}`
   - Credential: `Zendesk account`
2. **IF "Ticket Found and Not Acked?"**:
   - Condition: ticket exists AND its `tags` does not include `betterstack-acked`.
3. **TRUE branch**: Zendesk Update with:
   - tags: existing tags + `betterstack-acked`
   - comment: `{ body: "Incident acknowledged at " + acknowledged_at + " by " + (acknowledged_by || "unknown"), public: false }`
4. **FALSE branch**: NoOp (no ticket = handled in started branch via reopened path; already-acked = idempotency).

For the rare case "ack arrives before started", we accept missing the ack comment in v1 — the started webhook will still create the ticket and the resolved webhook will still resolve it. Document this trade-off in a Sticky Note rather than building queue logic.

- [ ] **Step 2: Validate**

```
mcp__n8n-mcp__validate_workflow(code: <updated source>)
```

Expected: `valid: true`.

- [ ] **Step 3: Commit**

```bash
git add workflows/betterstack-zendesk/receiver.workflow.ts
git commit -m "feat(betterstack): receiver acknowledged branch"
```

### Task 2.4: Build the started branch

**Files:**
- Modify: `workflows/betterstack-zendesk/receiver.workflow.ts`

- [ ] **Step 1: Append nodes**

1. **Zendesk Search "Find Editable Ticket"**:
   - query: `tags:betterstack-incident-{{ $('Webhook').item.json.body.data.id }} status<closed`
2. **IF "Ticket Editable?"**:
   - TRUE → **Reopen path**: Zendesk Update on found ticket:
     - status: `open`
     - tags: existing tags minus `betterstack-resolved`, plus `betterstack-open`
     - comment: `{ body: "Incident reopened at " + started_at + ".", public: false }`
   - FALSE → **Create path**:
     - First, **Zendesk Search "Find Closed Ticket"**: query `tags:betterstack-incident-<id>` (no status filter).
     - **IF "Closed Ticket Exists?"**:
       - TRUE → **Zendesk Create** new ticket with `betterstack-incident-<id>`, `betterstack-open`, `automated`, `reopened` tags + comment "Original ticket #<closed-id> auto-closed before this incident reopened. Continuing investigation here."
       - FALSE → **Zendesk Create** new ticket (the normal new-incident path):
         - subject: `[Betterstack] {{ name }} is down`
         - description / first comment: monitor URL, cause, started_at, screenshot URL if present, link to Betterstack incident page (format: `https://uptime.betterstack.com/team/{{ TEAM_SLUG }}/incidents/{{ id }}` if known — otherwise omit).
         - priority: `<PRIORITY_FROM_TASK_0.2_STEP_7>` (default `high`)
         - tags: `betterstack-incident-<id>`, `betterstack-open`, `automated`
         - group_id: `<GROUP_ID_FROM_TASK_0.2_STEP_3>`
         - requester: `<REQUESTER_FROM_TASK_0.2_STEP_4>`
         - Credential: `Zendesk account`

- [ ] **Step 2: Validate**

```
mcp__n8n-mcp__validate_workflow(code: <updated source>)
```

Expected: `valid: true`.

- [ ] **Step 3: Commit**

```bash
git add workflows/betterstack-zendesk/receiver.workflow.ts
git commit -m "feat(betterstack): receiver started/reopen branch"
```

### Task 2.5: Deploy and test the receiver

**Files:** none

- [ ] **Step 1: Create the receiver workflow in n8n**

```
mcp__n8n-mcp__create_workflow_from_code({
  code: <full receiver source>,
  description: "Real-time receiver for Betterstack incident webhooks. Branches by timestamp inspection (started/acknowledged/resolved), creates/updates Zendesk tickets, calls the resolve sub-workflow on resolution. Bearer token auth via X-Webhook-Auth header."
})
```

Capture `RECEIVER_WORKFLOW_ID`.

- [ ] **Step 2: Activate the receiver**

```
mcp__n8n-mcp__publish_workflow({ workflowId: "<RECEIVER_WORKFLOW_ID>" })
```

The webhook URL becomes live at `https://twofifteen.app.n8n.cloud/webhook/betterstack-incident`.

- [ ] **Step 3: Smoke-test the started branch**

```bash
curl -X POST https://twofifteen.app.n8n.cloud/webhook/betterstack-incident \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Auth: Bearer $BETTERSTACK_WEBHOOK_TOKEN" \
  -d '{
    "data": {
      "id": "test-receiver-001",
      "type": "incident",
      "attributes": {
        "name": "[TEST] Synthetic Monitor",
        "url": "https://example.com",
        "cause": "Smoke-test from implementation plan task 2.5",
        "started_at": "2026-05-09T12:00:00Z",
        "acknowledged_at": null,
        "resolved_at": null
      },
      "relationships": { "monitor": { "data": { "id": "0" } } }
    }
  }'
```

Expected: 200 response. A new Zendesk ticket appears tagged `betterstack-incident-test-receiver-001`, `betterstack-open`, `automated`, status `open`, subject `[Betterstack] [TEST] Synthetic Monitor is down`.

- [ ] **Step 4: Smoke-test the acknowledged branch**

```bash
curl -X POST https://twofifteen.app.n8n.cloud/webhook/betterstack-incident \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Auth: Bearer $BETTERSTACK_WEBHOOK_TOKEN" \
  -d '{
    "data": {
      "id": "test-receiver-001",
      "type": "incident",
      "attributes": {
        "name": "[TEST] Synthetic Monitor",
        "url": "https://example.com",
        "cause": "Smoke-test",
        "started_at": "2026-05-09T12:00:00Z",
        "acknowledged_at": "2026-05-09T12:01:00Z",
        "resolved_at": null
      },
      "relationships": { "monitor": { "data": { "id": "0" } } }
    }
  }'
```

Expected: 200. Same ticket gets a new internal comment "Incident acknowledged at 2026-05-09T12:01:00Z…" and `betterstack-acked` tag.

- [ ] **Step 5: Smoke-test the resolved branch**

```bash
curl -X POST https://twofifteen.app.n8n.cloud/webhook/betterstack-incident \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Auth: Bearer $BETTERSTACK_WEBHOOK_TOKEN" \
  -d '{
    "data": {
      "id": "test-receiver-001",
      "type": "incident",
      "attributes": {
        "name": "[TEST] Synthetic Monitor",
        "url": "https://example.com",
        "cause": "Smoke-test",
        "started_at": "2026-05-09T12:00:00Z",
        "acknowledged_at": "2026-05-09T12:01:00Z",
        "resolved_at": "2026-05-09T12:08:30Z"
      },
      "relationships": { "monitor": { "data": { "id": "0" } } }
    }
  }'
```

Expected: 200. Same ticket transitions to `solved`, gains the resolution comment ("Total Outage Time - 0 Days, 0 Hours, 8 Minutes, 30 Seconds"), gains `betterstack-resolved` tag, loses `betterstack-open` tag.

- [ ] **Step 6: Smoke-test auth rejection**

```bash
curl -i -X POST https://twofifteen.app.n8n.cloud/webhook/betterstack-incident \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Auth: Bearer wrong-token" \
  -d '{}'
```

Expected: HTTP 401, body `{"error":"unauthorized"}`. No execution should appear in n8n's execution log (or one that returns immediately).

- [ ] **Step 7: Smoke-test idempotency**

Re-send the resolved payload from Step 5. Verify the ticket gains NO additional comment and remains `solved`.

- [ ] **Step 8: Smoke-test the reopen path**

Send another started-shape payload with the same `data.id: "test-receiver-001"`. The ticket (now `solved` but still within 24h) should reopen — status back to `open`, `betterstack-open` tag re-added, `betterstack-resolved` removed, plus a "reopened at …" comment.

- [ ] **Step 9: If any test failed, fix the workflow**

```
mcp__n8n-mcp__update_workflow({ workflowId: "<RECEIVER_WORKFLOW_ID>", code: <fixed source> })
```

Re-run the failing smoke test until it passes.

- [ ] **Step 10: Export JSON snapshot and commit**

```bash
python3 -c "
import json, urllib.request
url = 'https://twofifteen.app.n8n.cloud/api/v1/workflows/<RECEIVER_WORKFLOW_ID>'
req = urllib.request.Request(url)
req.add_header('X-N8N-API-KEY', open('.env').read().split('N8N_API_KEY=')[1].split('\n')[0])
data = json.loads(urllib.request.urlopen(req).read())
with open('betterstack-zendesk-receiver.json', 'w') as f:
    json.dump(data, f, indent=2)
"
git add betterstack-zendesk-receiver.json workflows/betterstack-zendesk/receiver.workflow.ts
git commit -m "feat(betterstack): deploy receiver workflow (id: <RECEIVER_WORKFLOW_ID>)"
```

- [ ] **Step 11: Clean up the synthetic test ticket**

In Zendesk, delete or close `test-receiver-001`'s ticket so it doesn't pollute reports.

---

## Phase 3: Polling Reconciler

### Task 3.1: Author the polling reconciler

**Files:**
- Create: `workflows/betterstack-zendesk/poller.workflow.ts`

- [ ] **Step 1: Write the workflow source**

Required nodes:

1. **Schedule Trigger** (`n8n-nodes-base.scheduleTrigger`):
   - interval: every 5 minutes (`rule.interval: [{ field: "minutes", minutesInterval: 5 }]`)

2. **Zendesk Search "Find Open Betterstack Tickets"**:
   - resource=ticket, operation=getAll, returnAll=true (or limit 100)
   - query: `tags:betterstack-open status<solved`
   - Credential: `Zendesk account`
   - Returns ticket array.

3. **Split In Batches** with batchSize=1 to iterate per ticket.

4. **Code "Extract Incident ID"**:
   ```javascript
   const ticket = $input.item.json;
   const tag = (ticket.tags || []).find(t => t.startsWith('betterstack-incident-'));
   if (!tag) {
     return [{ json: { skip: true, reason: 'no betterstack-incident tag', ticket_id: ticket.id } }];
   }
   const incidentId = tag.replace('betterstack-incident-', '');
   return [{ json: { incident_id: incidentId, ticket_id: ticket.id, ticket_tags: ticket.tags } }];
   ```

5. **IF "Skip?"**: branch on `$json.skip === true`. TRUE → NoOp. FALSE → continues.

6. **HTTP Request "Get Betterstack Incident"**:
   - method: GET
   - URL: `https://uptime.betterstack.com/api/v3/incidents/{{ $json.incident_id }}`
   - authentication: predefined credential type, credential `Betterstack Uptime API`
   - **continueOnFail: true** (so 404 doesn't kill the iteration)
   - **retry: 3, backoff: exponential**
   - Response: include `statusCode` so downstream branching can distinguish 200 / 404 / other.

7. **Switch "Status Branch"**:
   - Output 0 "resolved": `$node["Get Betterstack Incident"].json.data.attributes.status` equals `Resolved` (case-sensitive per docs)
   - Output 1 "404": HTTP statusCode equals 404
   - Output 2 "still-open": status is anything else (default fallback)

8. **Resolved branch** → **Execute Workflow** to `<RESOLVE_SUBWORKFLOW_ID>` with:
   - zendesk_ticket_id: `{{ $('Extract Incident ID').item.json.ticket_id }}`
   - incident_id: `{{ $('Extract Incident ID').item.json.incident_id }}`
   - incident: `{{ $node["Get Betterstack Incident"].json.data.attributes }}`

9. **404 branch** → **Zendesk Update** on the ticket:
   - tags: ticket_tags minus `betterstack-open`
   - comment: `{ body: "Underlying Betterstack incident no longer exists; clearing automation tag.", public: false }`

10. **Still-open branch** → NoOp (will recheck next cycle).

11. **Sticky Note** documenting the cadence, scope query, and the rate-limit caveat (Betterstack does not document a numeric rate limit).

- [ ] **Step 2: Validate**

```
mcp__n8n-mcp__validate_workflow(code: <source>)
```

Expected: `valid: true`. Common fix: HTTP Request node may need explicit `responseFormat: "json"`.

- [ ] **Step 3: Commit**

```bash
git add workflows/betterstack-zendesk/poller.workflow.ts
git commit -m "feat(betterstack): polling reconciler source"
```

### Task 3.2: Deploy and test the poller

**Files:** none

- [ ] **Step 1: Create the poller workflow in n8n**

```
mcp__n8n-mcp__create_workflow_from_code({
  code: <validated source>,
  description: "Polling fallback for Betterstack incidents. Every 5 min, finds Zendesk tickets tagged betterstack-open status<solved, looks up each on Betterstack API, calls resolve sub-workflow if Resolved or strips tag on 404."
})
```

Capture `POLLER_WORKFLOW_ID`. **Do NOT activate yet** — test manually first.

- [ ] **Step 2: Create a deliberately-stale test ticket**

In Zendesk, create a ticket:
- Subject: `[TEST] Poller smoke test`
- Status: `open`
- Tags: `betterstack-open`, `betterstack-incident-<REAL_RESOLVED_INCIDENT_ID>`, `automated`, `test`

Get `<REAL_RESOLVED_INCIDENT_ID>` by looking up a recently-resolved incident in the user's Betterstack dashboard, or by triggering one from a manual monitor pause/resume. Capture this ticket ID as `POLL_TEST_TICKET`.

If no real resolved incident exists, fall back to using `betterstack-incident-deliberately-fake-12345` and verify the 404 branch instead.

- [ ] **Step 3: Manually execute the poller**

```
mcp__n8n-mcp__execute_workflow({ workflowId: "<POLLER_WORKFLOW_ID>" })
```

Expected: execution succeeds, processes the test ticket, calls the sub-workflow (or strips the tag in the 404 fallback case).

- [ ] **Step 4: Verify the test ticket**

If used a real resolved incident: ticket should now be `solved` with resolution comment + tag changes.
If used a fake incident: `betterstack-open` tag is gone and a "no longer exists" comment is present.

- [ ] **Step 5: Activate the poller**

```
mcp__n8n-mcp__publish_workflow({ workflowId: "<POLLER_WORKFLOW_ID>" })
```

- [ ] **Step 6: Export JSON snapshot and commit**

```bash
python3 -c "
import json, urllib.request
url = 'https://twofifteen.app.n8n.cloud/api/v1/workflows/<POLLER_WORKFLOW_ID>'
req = urllib.request.Request(url)
req.add_header('X-N8N-API-KEY', open('.env').read().split('N8N_API_KEY=')[1].split('\n')[0])
data = json.loads(urllib.request.urlopen(req).read())
with open('betterstack-zendesk-poller.json', 'w') as f:
    json.dump(data, f, indent=2)
"
git add betterstack-zendesk-poller.json workflows/betterstack-zendesk/poller.workflow.ts
git commit -m "feat(betterstack): deploy polling reconciler (id: <POLLER_WORKFLOW_ID>)"
```

- [ ] **Step 7: Clean up the test ticket**

Delete or close `POLL_TEST_TICKET` in Zendesk.

---

## Phase 4: Production Cutover

### Task 4.1: Configure the Betterstack outgoing webhook

**Files:** none (Betterstack UI; user action)

- [ ] **Step 1: Walk the user through the Betterstack UI**

Tell the user:

> Open Betterstack → Uptime → Integrations → Exporting data → Outgoing webhooks → Configure.
>
> 1. Create a new webhook with type **Incident**.
> 2. Webhook URL: `https://twofifteen.app.n8n.cloud/webhook/betterstack-incident`
> 3. Trigger flags — enable: `on_incident_started`, `on_incident_acknowledged`, `on_incident_resolved`, `on_incident_reopened`. Leave `on_incident_comment` OFF.
> 4. Custom headers — add: `X-Webhook-Auth` = `Bearer <token from Task 0.2 step 2>`
> 5. Save.

- [ ] **Step 2: Trigger a synthetic test from Betterstack**

Ask the user to manually pause + resume one monitor (or use Betterstack's "Send test webhook" feature if available) to generate real `on_incident_started` and `on_incident_resolved` events.

- [ ] **Step 3: Verify a real ticket lifecycle**

Watch n8n executions for the receiver workflow. Confirm a new Zendesk ticket appears, then resolves cleanly within seconds of the Betterstack incident resolving.

- [ ] **Step 4: No commit (config-only step)**

### Task 4.2: Disable the Zapier zap

**Files:** none (Zapier UI; user action; coordination point)

- [ ] **Step 1: Confirm with the user**

After at least one real incident has cycled through the new n8n workflow successfully, ask the user to **turn off** the existing Zapier zap. **Do not delete it** — leave it disabled for one week as a rollback option.

- [ ] **Step 2: Document the cutover date in the workflow README**

(Done in Task 5.1.)

- [ ] **Step 3: No commit yet (waits for Task 5.x)**

---

## Phase 5: Documentation

### Task 5.1: Write workflow README

**Files:**
- Create: `workflows/betterstack-zendesk/README.md`

- [ ] **Step 1: Write the README**

Content:
```markdown
# Betterstack → Zendesk Incident Workflow

Three n8n workflows that mirror Betterstack uptime incidents into Zendesk tickets.

## Workflows

| File | n8n ID | Purpose |
|------|--------|---------|
| `receiver.workflow.ts` | <RECEIVER_WORKFLOW_ID> | Real-time webhook receiver |
| `poller.workflow.ts` | <POLLER_WORKFLOW_ID> | 5-min polling reconciler |
| `resolve-subworkflow.workflow.ts` | <RESOLVE_SUBWORKFLOW_ID> | Shared resolution logic |

## Webhook URL

`https://twofifteen.app.n8n.cloud/webhook/betterstack-incident`

Configured in Betterstack: **Uptime → Integrations → Exporting data → Outgoing webhooks**.

## Auth

- Incoming webhook: `X-Webhook-Auth: Bearer <token>` header. Token in n8n env var `BETTERSTACK_WEBHOOK_TOKEN`.
- Outbound to Betterstack API: n8n credential `Betterstack Uptime API` (Header Auth, Bearer token).
- Zendesk: existing `Zendesk account` credential (shared with other workflows).

## Tag Vocabulary on Zendesk Tickets

| Tag | Meaning |
|---|---|
| `betterstack-incident-<id>` | Maps ticket to Betterstack incident. Permanent. |
| `betterstack-open` | Open + needs polling check. Removed at resolution. |
| `betterstack-resolved` | Idempotency sentinel. Permanent. |
| `betterstack-acked` | Idempotency sentinel for ack comment. Permanent. |
| `automated` | Marks bot-created tickets (existing convention). |
| `reopened` | Set when reopen-after-close creates a fresh ticket. |

## Field Configuration

- Group: `<GROUP_ID>` (`<GROUP_NAME>`)
- Requester: `<REQUESTER>`
- Priority on creation: `<PRIORITY>`
- Category custom field on resolution: `<CATEGORY_FIELD_ID>` = `<CATEGORY_VALUE>`
- Type custom field on resolution: `<TYPE_FIELD_ID>` = `<TYPE_VALUE>`
- Resolution comment public: `<true|false>`

## Cutover

Replaced Zapier zap "<old zap name>" on `<DATE>`. Zap left disabled (not deleted) for rollback.

## Operational Notes

- A 404 from Betterstack API during polling means the incident was deleted on the Betterstack side. The poller strips `betterstack-open` and adds an explanatory comment.
- 24-hour-closed Zendesk tickets are immutable. Reopens after closure create a fresh ticket linked to the original.
- Ack-arriving-before-create is intentionally not queued; the started/resolved webhooks still fire and produce a complete ticket lifecycle.
- Errors post to Slack channel `<SLACK_CHANNEL>` via attached error workflow `<ERROR_WORKFLOW_ID>`.

## See Also

- Spec: `docs/superpowers/specs/2026-05-09-betterstack-zendesk-incident-workflow-design.md`
- Plan: `docs/superpowers/plans/2026-05-09-betterstack-zendesk-incident-workflow.md`
```

Replace the `<...>` placeholders with the actual values captured in Task 0.2 and the workflow IDs from Phases 1–3.

- [ ] **Step 2: Commit**

```bash
git add workflows/betterstack-zendesk/README.md
git commit -m "docs(betterstack): operational README"
```

### Task 5.2: Update CLAUDE.md workflow registry

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add three rows to the "Current Workflows" table**

Locate the table at the top of `CLAUDE.md` (currently has 5 rows). Add:

| File | Name | Description | n8n ID | Status |
|------|------|-------------|--------|--------|
| `betterstack-zendesk-receiver.json` | Betterstack → Zendesk Receiver | Real-time webhook receiver for Betterstack incidents; creates/updates Zendesk tickets | `<RECEIVER_WORKFLOW_ID>` | Active |
| `betterstack-zendesk-poller.json` | Betterstack → Zendesk Poller | 5-min reconciler that catches missed resolution webhooks | `<POLLER_WORKFLOW_ID>` | Active |
| `betterstack-zendesk-resolve.json` | Betterstack Resolve Sub-workflow | Shared resolution logic with idempotency sentinels | `<RESOLVE_SUBWORKFLOW_ID>` | Active |

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): register Betterstack workflows"
```

### Task 5.3: Set up error-notification workflow (optional but recommended)

**Files:**
- Create: `workflows/betterstack-zendesk/error-notify.workflow.ts`

- [ ] **Step 1: Author a minimal error workflow**

```
- Error Trigger node
- Slack node:
  - resource: message, operation: post, select: channel
  - channelId: <SLACK_CHANNEL_FROM_TASK_0.2_STEP_8>
  - text: "Workflow {{ $json.workflow.name }} failed (execution {{ $json.execution.id }}): {{ $json.execution.error.message }}"
```

- [ ] **Step 2: Validate**

```
mcp__n8n-mcp__validate_workflow(code: <source>)
```

- [ ] **Step 3: Create + activate**

```
mcp__n8n-mcp__create_workflow_from_code({ code: <source>, description: "Error notifier for the Betterstack→Zendesk workflows. Posts to Slack on any unhandled error." })
mcp__n8n-mcp__publish_workflow({ workflowId: "<ERROR_WORKFLOW_ID>" })
```

- [ ] **Step 4: Attach to the three production workflows**

For each of receiver / poller / resolve sub-workflow, set `errorWorkflow: "<ERROR_WORKFLOW_ID>"` in the workflow settings (via `mcp__n8n-mcp__update_workflow` with the updated source).

- [ ] **Step 5: Test by deliberately breaking one workflow temporarily**

E.g., point the receiver's HTTP node at a bad URL, fire a webhook, verify the Slack alert arrives. Then revert.

- [ ] **Step 6: Commit**

```bash
git add workflows/betterstack-zendesk/error-notify.workflow.ts
git commit -m "feat(betterstack): error-notification workflow"
```

---

## Verification Checklist (Run Before Marking Done)

- [ ] All three workflows show `active: true` in n8n.
- [ ] A real Betterstack incident has cycled through the receiver: ticket created on `started`, resolved with downtime calculation on `resolved`.
- [ ] Polling reconciler has run at least once and processed (or no-op'd over) any open tickets.
- [ ] Auth rejection test (Task 2.5 Step 6) returns 401.
- [ ] Idempotency test (Task 2.5 Step 7) does not double-comment.
- [ ] Reopen test (Task 2.5 Step 8) reopens the ticket, doesn't create a duplicate.
- [ ] CLAUDE.md table shows the three new workflows.
- [ ] Zapier zap is disabled (not deleted), confirmed by user.
- [ ] README placeholders all replaced with real values.
