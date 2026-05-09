import {
  workflow,
  trigger,
  node,
  sticky,
  newCredential,
  ifElse,
  expr,
} from '@n8n/workflow-sdk';

// ---------------------------------------------------------------------------
// TODO placeholders — replace before activating in n8n.
// These constants are baked into the Zendesk update node's expression at
// workflow-compile time, so editing them requires re-deploying the workflow.
// ---------------------------------------------------------------------------
const CATEGORY_FIELD_ID = 0; // TODO_CATEGORY_FIELD_ID: real Zendesk custom field ID
const CATEGORY_VALUE = 'TODO_CATEGORY_VALUE'; // TODO: real category tag value
const TYPE_FIELD_ID = 0; // TODO_TYPE_FIELD_ID: real Zendesk custom field ID
const TYPE_VALUE = 'TODO_TYPE_VALUE'; // TODO: real type tag value
const COMMENT_PUBLIC = true; // Default true (matches Zapier zap). Flip to false to make resolution comment internal.

// ---------------------------------------------------------------------------
// Trigger: Execute Workflow Trigger declares the inputs callers must pass.
// ---------------------------------------------------------------------------
const executeWorkflowTrigger = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Execute Workflow Trigger',
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'zendesk_ticket_id', type: 'string' },
          { name: 'incident_id', type: 'string' },
          { name: 'incident', type: 'object' },
        ],
      },
    },
    position: [240, 300],
  },
  output: [
    {
      zendesk_ticket_id: '12345',
      incident_id: 'inc-abc-123',
      incident: {
        name: 'Example Monitor',
        url: 'https://example.com',
        cause: 'HTTP 500',
        started_at: '2026-05-09T10:00:00Z',
        resolved_at: '2026-05-09T10:05:30Z',
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Step 1: Fetch the current Zendesk ticket so we can inspect its tags
// for the idempotency sentinel and use them as the basis for the new tag set.
// ---------------------------------------------------------------------------
const getZendeskTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Get Zendesk Ticket',
    parameters: {
      resource: 'ticket',
      operation: 'get',
      id: expr('{{ $json.zendesk_ticket_id }}'),
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [480, 300],
  },
  output: [
    {
      id: 12345,
      status: 'open',
      tags: ['betterstack-incident-inc-abc-123', 'betterstack-open', 'automated'],
      subject: '[Betterstack] Example Monitor is down',
    },
  ],
});

// ---------------------------------------------------------------------------
// Step 2: Idempotency gate. If the ticket already has the betterstack-resolved
// sentinel tag, this run is a duplicate (webhook retry, poller race, etc.) and
// must no-op so we don't double-comment or double-update.
// ---------------------------------------------------------------------------
const alreadyResolvedCheck = ifElse({
  version: 2.3,
  config: {
    name: 'Already Resolved?',
    parameters: {
      conditions: {
        options: {
          version: 2,
          leftValue: '',
          caseSensitive: true,
          typeValidation: 'strict',
        },
        combinator: 'and',
        conditions: [
          {
            id: 'has-resolved-tag',
            leftValue: expr('{{ $json.tags.includes("betterstack-resolved") }}'),
            rightValue: true,
            operator: { type: 'boolean', operation: 'equals' },
          },
        ],
      },
      options: {},
    },
    position: [720, 300],
  },
});

// True branch: already-resolved → silent no-op.
const alreadyResolvedNoop = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: {
    name: 'Already Resolved (No-op)',
    parameters: {},
    position: [960, 180],
  },
  output: [{ skipped: true, reason: 'betterstack-resolved tag already present' }],
});

// ---------------------------------------------------------------------------
// Step 3: Compute downtime + format the resolution comment + the new tag list.
// JS body matches the plan (Task 1.1 step 1) so the format matches the
// Zapier zap output exactly.
// ---------------------------------------------------------------------------
const computeDowntimeJs = `const ticket = $('Get Zendesk Ticket').item.json;
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

const lines = [
  'Status - resolved',
  '',
  'Title of the failing monitor: ' + incident.name,
  'Cause of the incident: ' + cause,
  'ID: ' + incidentId,
  '',
  'Start Time - ' + fmt(startedAt),
  'Resolution Time - ' + fmt(resolvedAt),
  '',
  'Total Outage Time - ' + days + ' Days, ' + hours + ' Hours, ' + minutes + ' Minutes, ' + seconds + ' Seconds',
];
const comment = lines.join('\\n');

const newTags = ticket.tags
  .filter((t) => t !== 'betterstack-open')
  .concat(['betterstack-resolved']);

return [{ json: { comment: comment, newTags: newTags, ticket_id: ticket.id } }];`;

const computeDowntime = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute Downtime + Format Comment',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: computeDowntimeJs,
    },
    position: [960, 420],
  },
  output: [
    {
      comment:
        'Status - resolved\n\nTitle of the failing monitor: Example Monitor\nCause of the incident: HTTP 500\nID: inc-abc-123\n\nStart Time - 9 May 2026 at 10:00 am UTC\nResolution Time - 9 May 2026 at 10:05 am UTC\n\nTotal Outage Time - 0 Days, 0 Hours, 5 Minutes, 30 Seconds',
      newTags: [
        'betterstack-incident-inc-abc-123',
        'automated',
        'betterstack-resolved',
      ],
      ticket_id: 12345,
    },
  ],
});

// ---------------------------------------------------------------------------
// Step 4: Update the Zendesk ticket in a single API call. We use the
// updateFieldsJson parameter pattern (matching zendesk-ai-priority-classifier-webhook.json)
// because n8n's structured updateFields does not expose tags-as-array,
// custom_fields-as-array, or comment.public.
// ---------------------------------------------------------------------------
const updateFieldsJsonExpression =
  '={{ JSON.stringify({ status: "solved", tags: $json.newTags, comment: { body: $json.comment, public: ' +
  (COMMENT_PUBLIC ? 'true' : 'false') +
  ' }, custom_fields: [ { id: ' +
  CATEGORY_FIELD_ID +
  ', value: "' +
  CATEGORY_VALUE +
  '" }, { id: ' +
  TYPE_FIELD_ID +
  ', value: "' +
  TYPE_VALUE +
  '" } ] }) }}';

const updateZendeskTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Update Zendesk Ticket',
    parameters: {
      resource: 'ticket',
      operation: 'update',
      id: expr('{{ $json.ticket_id }}'),
      jsonParameters: true,
      updateFieldsJson: expr(updateFieldsJsonExpression),
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [1200, 420],
  },
  output: [
    {
      id: 12345,
      status: 'solved',
      tags: [
        'betterstack-incident-inc-abc-123',
        'automated',
        'betterstack-resolved',
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// Documentation sticky notes.
// ---------------------------------------------------------------------------
const docSticky = sticky(
  '## Betterstack Resolve Sub-workflow\n\n' +
    '**Purpose**: Shared resolution logic for Betterstack incidents. Called by:\n' +
    '- `betterstack-zendesk-receiver` (real-time webhook receiver)\n' +
    '- `betterstack-zendesk-poller` (5-min reconciler fallback)\n\n' +
    '**Inputs** (Execute Workflow Trigger):\n' +
    '- `zendesk_ticket_id` (string) — the Zendesk ticket to resolve\n' +
    '- `incident_id` (string) — the Betterstack incident ID (for the comment)\n' +
    '- `incident` (object) — the full Betterstack `data.attributes` payload\n' +
    '  (must contain `name`, `cause`, `started_at`, `resolved_at`)\n\n' +
    '**Idempotency**: First node fetches the ticket and the IF gate checks\n' +
    'for the `betterstack-resolved` tag. If present → no-op. If absent → run\n' +
    'the resolve flow and the Zendesk update appends `betterstack-resolved`\n' +
    'to the tags as the sentinel. This makes webhook retries and webhook/poller\n' +
    'races safe.\n\n' +
    '**Tag mutations** (computed in the Code node, applied as a full replacement):\n' +
    '- removes `betterstack-open`\n' +
    '- adds `betterstack-resolved`\n' +
    '- preserves all other existing tags',
  [],
  { color: 4 }
);

const todoSticky = sticky(
  '## TODOs before activation\n\n' +
    'Edit constants at the top of `resolve-subworkflow.workflow.ts`:\n\n' +
    '- `CATEGORY_FIELD_ID` — Zendesk custom field ID for category\n' +
    '- `CATEGORY_VALUE` — value to write to that field on resolution\n' +
    '- `TYPE_FIELD_ID` — Zendesk custom field ID for type\n' +
    '- `TYPE_VALUE` — value to write to that field on resolution\n' +
    '- `COMMENT_PUBLIC` — currently `true` (matches Zapier zap). Flip to `false`\n' +
    '  if the resolution comment should be an internal note.\n\n' +
    'After editing, re-validate and `mcp__n8n-mcp__update_workflow` to redeploy.',
  [],
  { color: 5 }
);

// ---------------------------------------------------------------------------
// Compose the workflow.
// ---------------------------------------------------------------------------
export default workflow('betterstack-resolve', 'Betterstack Resolve Sub-workflow')
  .add(executeWorkflowTrigger)
  .to(getZendeskTicket)
  .to(
    alreadyResolvedCheck
      .onTrue(alreadyResolvedNoop)
      .onFalse(computeDowntime.to(updateZendeskTicket))
  )
  .add(docSticky)
  .add(todoSticky);
