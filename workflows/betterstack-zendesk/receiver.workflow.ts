import {
  workflow,
  trigger,
  node,
  sticky,
  newCredential,
  ifElse,
  switchCase,
  expr,
} from '@n8n/workflow-sdk';

// ---------------------------------------------------------------------------
// TODO placeholders — replace before activating in n8n.
// These values are baked into node parameters at workflow-compile time, so
// editing them requires re-deploying the workflow.
// ---------------------------------------------------------------------------
const GROUP_ID = '0'; // TODO: real Zendesk group ID for auto-created tickets
const REQUESTER_EMAIL = 'TODO_REQUESTER@example.com'; // TODO: real requester
const PRIORITY = 'high'; // confirmed default per spec
const COMMENT_PUBLIC = true; // matches existing Zapier zap; resolution comment public flag
const RESOLVE_SUBWORKFLOW_ID = 'FXjwcoWpPhmv76ws'; // resolve sub-workflow (Phase 1)

// ===========================================================================
// TRIGGER + AUTH GATE
// ===========================================================================

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'betterstack-incident',
      responseMode: 'responseNode',
      options: {},
    },
    position: [240, 600],
  },
  output: [
    {
      headers: { 'x-webhook-auth': 'Bearer placeholder-token' },
      body: {
        data: {
          id: 'inc-abc-123',
          type: 'incident',
          attributes: {
            name: 'Example Monitor',
            url: 'https://example.com',
            cause: 'HTTP 500',
            started_at: '2026-05-09T10:00:00Z',
            acknowledged_at: null,
            resolved_at: null,
            screenshot_url: null,
          },
          relationships: { monitor: { data: { id: '1', type: 'monitor' } } },
        },
      },
    },
  ],
});

const verifyBearerToken = ifElse({
  version: 2.3,
  config: {
    name: 'Verify Bearer Token',
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
            id: 'auth-match',
            leftValue: expr('{{ $json.headers["x-webhook-auth"] }}'),
            rightValue: expr('{{ "Bearer " + $env.BETTERSTACK_WEBHOOK_TOKEN }}'),
            operator: { type: 'string', operation: 'equals' },
          },
        ],
      },
      options: {},
    },
    position: [480, 600],
  },
});

const respondUnauthorized = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond 401',
    parameters: {
      respondWith: 'json',
      responseBody: '={{ { "error": "unauthorized" } }}',
      options: { responseCode: 401 },
    },
    position: [720, 760],
  },
  output: [{ error: 'unauthorized' }],
});

// ===========================================================================
// SWITCH: BRANCH BY EVENT TYPE (timestamp-based discriminator)
// Output 0 = resolved, 1 = acknowledged, 2 = started.
// ===========================================================================

const branchByEvent = switchCase({
  version: 3.4,
  config: {
    name: 'Branch by Event',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'loose' },
              combinator: 'and',
              conditions: [
                {
                  id: 'is-resolved',
                  leftValue: expr('{{ $json.body.data.attributes.resolved_at }}'),
                  rightValue: '',
                  operator: { type: 'string', operation: 'notEmpty', singleValue: true },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'resolved',
          },
          {
            conditions: {
              options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'loose' },
              combinator: 'and',
              conditions: [
                {
                  id: 'has-acked',
                  leftValue: expr('{{ $json.body.data.attributes.acknowledged_at }}'),
                  rightValue: '',
                  operator: { type: 'string', operation: 'notEmpty', singleValue: true },
                },
                {
                  id: 'no-resolved',
                  leftValue: expr('{{ $json.body.data.attributes.resolved_at }}'),
                  rightValue: '',
                  operator: { type: 'string', operation: 'empty', singleValue: true },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'acknowledged',
          },
          {
            conditions: {
              options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'loose' },
              combinator: 'and',
              conditions: [
                {
                  id: 'no-acked',
                  leftValue: expr('{{ $json.body.data.attributes.acknowledged_at }}'),
                  rightValue: '',
                  operator: { type: 'string', operation: 'empty', singleValue: true },
                },
                {
                  id: 'no-resolved-2',
                  leftValue: expr('{{ $json.body.data.attributes.resolved_at }}'),
                  rightValue: '',
                  operator: { type: 'string', operation: 'empty', singleValue: true },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'started',
          },
        ],
      },
      options: { fallbackOutput: 'none' },
    },
    position: [720, 600],
  },
});

// ===========================================================================
// SHARED: format the resolution comment (used by resolved-without-create
// path AND by the resolve sub-workflow). Duplication is documented in a
// sticky note — extracting to a true shared module would require a
// dedicated "format comment" sub-workflow, which is overkill for one extra
// caller. Keep behavior in lockstep with resolve-subworkflow.workflow.ts.
// ===========================================================================
const formatResolutionCommentJs = `const incident = $('Webhook').item.json.body.data.attributes;
const incidentId = $('Webhook').item.json.body.data.id;

const startedAt = new Date(incident.started_at);
const resolvedAt = new Date(incident.resolved_at);
const diffMs = resolvedAt - startedAt;

const fmt = (d) => {
  if (!(d instanceof Date) || isNaN(d.getTime())) {
    return String(d);
  }
  const formatted = d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'UTC',
  }).replace(',', ' at');
  return formatted.replace(/\\s(am|pm)/i, (_, p) => p.toLowerCase()) + ' UTC';
};

const cause = incident.cause || 'Not specified';

let outageLine;
if (isNaN(diffMs) || diffMs < 0) {
  outageLine = 'Total Outage Time - Unknown';
} else {
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  outageLine = 'Total Outage Time - ' + days + ' Days, ' + hours + ' Hours, ' + minutes + ' Minutes, ' + seconds + ' Seconds';
}

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
  outageLine,
];
const comment = lines.join('\\n');

return [{ json: { comment: comment, incident_id: incidentId, incident: incident } }];`;

// ===========================================================================
// RESOLVED BRANCH (output 0)
// ===========================================================================

const findOpenTicketResolved = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Find Open Ticket (Resolved)',
    parameters: {
      resource: 'ticket',
      operation: 'getAll',
      returnAll: false,
      limit: 1,
      options: {
        query: expr(
          '={{ "tags:betterstack-incident-" + $(\'Webhook\').item.json.body.data.id + " status<closed" }}'
        ),
      },
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [960, 240],
  },
  output: [
    {
      id: 12345,
      status: 'open',
      tags: ['betterstack-incident-inc-abc-123', 'betterstack-open', 'automated'],
    },
  ],
});

const resolvedTicketFound = ifElse({
  version: 2.3,
  config: {
    name: 'Resolved: Ticket Found?',
    parameters: {
      conditions: {
        options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' },
        combinator: 'and',
        conditions: [
          {
            id: 'has-ticket-id',
            leftValue: expr('{{ $json.id }}'),
            rightValue: 0,
            operator: { type: 'number', operation: 'gt' },
          },
        ],
      },
      options: { looseTypeValidation: true },
    },
    position: [1200, 240],
  },
});

const callResolveSubworkflow = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Call Resolve Sub-workflow',
    parameters: {
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: RESOLVE_SUBWORKFLOW_ID },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          zendesk_ticket_id: expr(
            '={{ $(\'Find Open Ticket (Resolved)\').item.json.id }}'
          ),
          incident_id: expr("={{ $('Webhook').item.json.body.data.id }}"),
          incident: expr("={{ $('Webhook').item.json.body.data.attributes }}"),
        },
        schema: [
          { id: 'zendesk_ticket_id', displayName: 'zendesk_ticket_id', required: true, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'incident_id', displayName: 'incident_id', required: true, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'incident', displayName: 'incident', required: true, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'object' },
        ],
        matchingColumns: [],
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      mode: 'each',
      options: { waitForSubWorkflow: true },
    },
    position: [1440, 120],
  },
  output: [{ resolved: true }],
});

const formatCommentForCreate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Format Resolution Comment (Pre-create)',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: formatResolutionCommentJs,
    },
    position: [1440, 360],
  },
  output: [
    {
      comment: 'Status - resolved\n\nTitle of the failing monitor: Example Monitor\nCause of the incident: HTTP 500\nID: inc-abc-123\n\nStart Time - 9 May 2026 at 10:00am UTC\nResolution Time - 9 May 2026 at 10:05am UTC\n\nTotal Outage Time - 0 Days, 0 Hours, 5 Minutes, 30 Seconds',
      incident_id: 'inc-abc-123',
      incident: { name: 'Example Monitor', url: 'https://example.com', cause: 'HTTP 500', started_at: '2026-05-09T10:00:00Z', resolved_at: '2026-05-09T10:05:30Z' },
    },
  ],
});

// JSON.stringify-wrapped expression — special chars in placeholders produce
// valid JS string literals when assembled at SDK build time.
const createSolvedAdditionalFieldsExpression =
  '={{ JSON.stringify({ subject: "[Betterstack] " + $(\'Webhook\').item.json.body.data.attributes.name + " is down", status: "solved", priority: ' +
  JSON.stringify(PRIORITY) +
  ', group_id: ' +
  JSON.stringify(GROUP_ID) +
  ', requester: { email: ' +
  JSON.stringify(REQUESTER_EMAIL) +
  ' }, tags: ["betterstack-incident-" + $(\'Webhook\').item.json.body.data.id, "betterstack-resolved", "automated"], comment: { body: $json.comment, public: ' +
  (COMMENT_PUBLIC ? 'true' : 'false') +
  ' } }) }}';

const createSolvedTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Create Ticket (Already Resolved)',
    parameters: {
      resource: 'ticket',
      operation: 'create',
      description: expr('={{ $json.comment }}'),
      jsonParameters: true,
      additionalFieldsJson: expr(createSolvedAdditionalFieldsExpression),
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [1680, 360],
  },
  output: [
    { id: 99999, status: 'solved', tags: ['betterstack-incident-inc-abc-123', 'betterstack-resolved', 'automated'] },
  ],
});

const respondResolved = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond 200 (Resolved)',
    parameters: {
      respondWith: 'json',
      responseBody: '={{ { "ok": true, "branch": "resolved" } }}',
      options: { responseCode: 200 },
    },
    position: [1920, 240],
  },
  output: [{ ok: true, branch: 'resolved' }],
});

// ===========================================================================
// ACKNOWLEDGED BRANCH (output 1)
// ===========================================================================

const findOpenTicketAck = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Find Open Ticket (Ack)',
    parameters: {
      resource: 'ticket',
      operation: 'getAll',
      returnAll: false,
      limit: 1,
      options: {
        query: expr(
          '={{ "tags:betterstack-incident-" + $(\'Webhook\').item.json.body.data.id + " status<closed" }}'
        ),
      },
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [960, 600],
  },
  output: [
    { id: 12345, status: 'open', tags: ['betterstack-incident-inc-abc-123', 'betterstack-open', 'automated'] },
  ],
});

const ackTicketFoundAndUnacked = ifElse({
  version: 2.3,
  config: {
    name: 'Ack: Ticket Found and Not Acked?',
    parameters: {
      conditions: {
        options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'loose' },
        combinator: 'and',
        conditions: [
          { id: 'has-ticket', leftValue: expr('{{ $json.id }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } },
          { id: 'no-acked-tag', leftValue: expr('{{ ($json.tags || []).includes("betterstack-acked") }}'), rightValue: false, operator: { type: 'boolean', operation: 'equals' } },
        ],
      },
      options: { looseTypeValidation: true },
    },
    position: [1200, 600],
  },
});

// Append ack comment AND set sentinel tag in a single Zendesk update so the
// sentinel is only persisted if the comment write succeeds.
const ackUpdateExpression =
  '={{ JSON.stringify({ tags: ($json.tags || []).concat(["betterstack-acked"]), comment: { body: "Incident acknowledged at " + ($(\'Webhook\').item.json.body.data.attributes.acknowledged_at || "unknown time") + " by " + ($(\'Webhook\').item.json.body.data.attributes.acknowledged_by || "unknown"), public: false } }) }}';

const updateTicketAck = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Update Ticket (Ack)',
    parameters: {
      resource: 'ticket',
      operation: 'update',
      id: expr('={{ $json.id }}'),
      jsonParameters: true,
      updateFieldsJson: expr(ackUpdateExpression),
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [1440, 480],
  },
  output: [
    { id: 12345, status: 'open', tags: ['betterstack-incident-inc-abc-123', 'betterstack-open', 'automated', 'betterstack-acked'] },
  ],
});

const ackNoOp = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Ack No-op (No Ticket or Already Acked)', parameters: {}, position: [1440, 720] },
  output: [{ skipped: true, reason: 'no ticket or already acked' }],
});

const respondAck = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond 200 (Ack)',
    parameters: {
      respondWith: 'json',
      responseBody: '={{ { "ok": true, "branch": "acknowledged" } }}',
      options: { responseCode: 200 },
    },
    position: [1680, 600],
  },
  output: [{ ok: true, branch: 'acknowledged' }],
});

// ===========================================================================
// STARTED BRANCH (output 2) — with reopen + create-from-closed paths
// ===========================================================================

const findEditableTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Find Editable Ticket (Started)',
    parameters: {
      resource: 'ticket',
      operation: 'getAll',
      returnAll: false,
      limit: 1,
      options: {
        query: expr(
          '={{ "tags:betterstack-incident-" + $(\'Webhook\').item.json.body.data.id + " status<closed" }}'
        ),
      },
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [960, 960],
  },
  output: [
    { id: 12345, status: 'solved', tags: ['betterstack-incident-inc-abc-123', 'betterstack-resolved', 'automated'] },
  ],
});

const startedTicketEditable = ifElse({
  version: 2.3,
  config: {
    name: 'Started: Editable Ticket?',
    parameters: {
      conditions: {
        options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'loose' },
        combinator: 'and',
        conditions: [
          { id: 'has-editable-ticket', leftValue: expr('{{ $json.id }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } },
        ],
      },
      options: { looseTypeValidation: true },
    },
    position: [1200, 960],
  },
});

// Reopen update: status=open, swap betterstack-resolved → betterstack-open,
// append reopened comment. Single API call.
const reopenUpdateExpression =
  '={{ JSON.stringify({ status: "open", tags: ($json.tags || []).filter(function(t) { return t !== "betterstack-resolved"; }).concat(["betterstack-open"]), comment: { body: "Incident reopened at " + ($(\'Webhook\').item.json.body.data.attributes.started_at || "unknown time") + ".", public: false } }) }}';

const reopenTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Reopen Ticket',
    parameters: {
      resource: 'ticket',
      operation: 'update',
      id: expr('={{ $json.id }}'),
      jsonParameters: true,
      updateFieldsJson: expr(reopenUpdateExpression),
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [1440, 840],
  },
  output: [
    { id: 12345, status: 'open', tags: ['betterstack-incident-inc-abc-123', 'automated', 'betterstack-open'] },
  ],
});

const findClosedTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Find Any Ticket (Closed Lookup)',
    parameters: {
      resource: 'ticket',
      operation: 'getAll',
      returnAll: false,
      limit: 1,
      options: {
        query: expr(
          '={{ "tags:betterstack-incident-" + $(\'Webhook\').item.json.body.data.id }}'
        ),
      },
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [1440, 1080],
  },
  output: [
    { id: 12340, status: 'closed', tags: ['betterstack-incident-inc-abc-123', 'betterstack-resolved'] },
  ],
});

const closedTicketExists = ifElse({
  version: 2.3,
  config: {
    name: 'Closed Ticket Exists?',
    parameters: {
      conditions: {
        options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'loose' },
        combinator: 'and',
        conditions: [
          { id: 'has-closed-ticket', leftValue: expr('{{ $json.id }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } },
        ],
      },
      options: { looseTypeValidation: true },
    },
    position: [1680, 1080],
  },
});

const createLinkedDescriptionExpression =
  '={{ "Original ticket #" + $json.id + " auto-closed before this incident reopened. Continuing investigation here.\\n\\nMonitor: " + $(\'Webhook\').item.json.body.data.attributes.name + "\\nURL: " + ($(\'Webhook\').item.json.body.data.attributes.url || "n/a") + "\\nCause: " + ($(\'Webhook\').item.json.body.data.attributes.cause || "Not specified") + "\\nStarted at: " + ($(\'Webhook\').item.json.body.data.attributes.started_at || "unknown") + ($(\'Webhook\').item.json.body.data.attributes.screenshot_url ? ("\\nScreenshot: " + $(\'Webhook\').item.json.body.data.attributes.screenshot_url) : "") }}';

const createLinkedAdditionalFieldsExpression =
  '={{ JSON.stringify({ subject: "[Betterstack] " + $(\'Webhook\').item.json.body.data.attributes.name + " is down", status: "open", priority: ' +
  JSON.stringify(PRIORITY) +
  ', group_id: ' +
  JSON.stringify(GROUP_ID) +
  ', requester: { email: ' +
  JSON.stringify(REQUESTER_EMAIL) +
  ' }, tags: ["betterstack-incident-" + $(\'Webhook\').item.json.body.data.id, "betterstack-open", "automated", "reopened"] }) }}';

const createLinkedTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Create Ticket (Linked to Closed)',
    parameters: {
      resource: 'ticket',
      operation: 'create',
      description: expr(createLinkedDescriptionExpression),
      jsonParameters: true,
      additionalFieldsJson: expr(createLinkedAdditionalFieldsExpression),
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [1920, 960],
  },
  output: [
    { id: 99998, status: 'open', tags: ['betterstack-incident-inc-abc-123', 'betterstack-open', 'automated', 'reopened'] },
  ],
});

const createFreshDescriptionExpression =
  '={{ "Monitor: " + $(\'Webhook\').item.json.body.data.attributes.name + "\\nURL: " + ($(\'Webhook\').item.json.body.data.attributes.url || "n/a") + "\\nCause: " + ($(\'Webhook\').item.json.body.data.attributes.cause || "Not specified") + "\\nStarted at: " + ($(\'Webhook\').item.json.body.data.attributes.started_at || "unknown") + ($(\'Webhook\').item.json.body.data.attributes.screenshot_url ? ("\\nScreenshot: " + $(\'Webhook\').item.json.body.data.attributes.screenshot_url) : "") }}';

const createFreshAdditionalFieldsExpression =
  '={{ JSON.stringify({ subject: "[Betterstack] " + $(\'Webhook\').item.json.body.data.attributes.name + " is down", status: "open", priority: ' +
  JSON.stringify(PRIORITY) +
  ', group_id: ' +
  JSON.stringify(GROUP_ID) +
  ', requester: { email: ' +
  JSON.stringify(REQUESTER_EMAIL) +
  ' }, tags: ["betterstack-incident-" + $(\'Webhook\').item.json.body.data.id, "betterstack-open", "automated"] }) }}';

const createFreshTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Create Ticket (Fresh)',
    parameters: {
      resource: 'ticket',
      operation: 'create',
      description: expr(createFreshDescriptionExpression),
      jsonParameters: true,
      additionalFieldsJson: expr(createFreshAdditionalFieldsExpression),
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [1920, 1200],
  },
  output: [
    { id: 99997, status: 'open', tags: ['betterstack-incident-inc-abc-123', 'betterstack-open', 'automated'] },
  ],
});

const respondStarted = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond 200 (Started)',
    parameters: {
      respondWith: 'json',
      responseBody: '={{ { "ok": true, "branch": "started" } }}',
      options: { responseCode: 200 },
    },
    position: [2160, 1080],
  },
  output: [{ ok: true, branch: 'started' }],
});

// ===========================================================================
// STICKY NOTES
// ===========================================================================

const purposeSticky = sticky(
  '## Betterstack → Zendesk Receiver\n\n' +
    '**Purpose**: Real-time webhook receiver for Betterstack incident events.\n' +
    'Mirrors incident lifecycle into Zendesk tickets via tag-based state.\n\n' +
    '**Webhook URL**: `https://twofifteen.app.n8n.cloud/webhook/betterstack-incident`\n\n' +
    '**Auth**: `X-Webhook-Auth: Bearer <token>` header. Token in n8n env var\n' +
    '`BETTERSTACK_WEBHOOK_TOKEN`. Mismatch returns 401 + `{"error":"unauthorized"}`.\n\n' +
    '**Companion workflows**:\n' +
    '- Resolve sub-workflow `' + RESOLVE_SUBWORKFLOW_ID + '` (called for resolutions)\n' +
    '- Polling reconciler (5-min fallback for missed resolution webhooks)\n\n' +
    '**Spec**: `docs/superpowers/specs/2026-05-09-betterstack-zendesk-incident-workflow-design.md`',
  [],
  { color: 4 }
);

const discriminatorSticky = sticky(
  '## Event-type Discriminator\n\n' +
    'Betterstack docs only document the top-level `event` field for `comment`\n' +
    'events. For started / acknowledged / resolved / reopened, we MUST inspect\n' +
    '`data.attributes` timestamps:\n\n' +
    '| Condition | Branch |\n' +
    '|---|---|\n' +
    '| `resolved_at != null` | resolved (output 0) |\n' +
    '| `acknowledged_at != null && resolved_at == null` | acknowledged (output 1) |\n' +
    '| both null | started (output 2) |\n\n' +
    '**Switch fallback**: `fallbackOutput: "none"` — if a payload matches no\n' +
    'branch (shouldn\'t happen given the discriminator covers all 3 states),\n' +
    'the Switch silently drops it rather than crashing.',
  [],
  { color: 5 }
);

const ackTradeoffSticky = sticky(
  '## v1 Trade-off: Ack-Before-Create\n\n' +
    'If an `acknowledged` webhook arrives before `started` (out-of-order delivery),\n' +
    'the ack lookup finds no ticket and the branch no-ops — the ack comment is\n' +
    'lost. The subsequent `started` webhook will still create the ticket and the\n' +
    '`resolved` webhook will still resolve it; only the ack-comment annotation is\n' +
    'missing.\n\n' +
    'We accept this in v1 rather than queueing pending acks. If this becomes a\n' +
    'real operational issue, switch to a Code-node-buffered approach in v2.\n\n' +
    'Ack idempotency sentinel = `betterstack-acked` tag. Set in the same Zendesk\n' +
    'update call as the ack comment so a failed comment write never poisons the\n' +
    'sentinel.',
  [],
  { color: 5 }
);

const resolvedEdgeSticky = sticky(
  '## Edge Case: Resolved Without Create\n\n' +
    'If the `resolved` webhook arrives but no open ticket exists (the `started`\n' +
    'webhook was dropped), the FALSE branch creates the ticket directly in\n' +
    '`solved` state with the resolution comment baked in.\n\n' +
    '**Duplication note**: The resolution-comment formatter is duplicated\n' +
    'between `Format Resolution Comment (Pre-create)` here and `Compute Downtime\n' +
    '+ Format Comment` in the resolve sub-workflow. Both must stay in lockstep.\n' +
    'A shared "format comment" sub-workflow would centralize this, but adds an\n' +
    'extra hop for one extra caller — accepted as the cleanest n8n-native option.',
  [],
  { color: 5 }
);

const reopenSticky = sticky(
  '## Started Branch: Reopen vs Create\n\n' +
    '1. **Editable ticket exists** (`status<closed`) → reopen: status=open,\n' +
    '   swap `betterstack-resolved` → `betterstack-open`, append "reopened" comment.\n' +
    '2. **No editable ticket but a closed ticket exists** → create a NEW ticket\n' +
    '   tagged `reopened`, with a comment linking back to the closed original.\n' +
    '   (Zendesk auto-closes solved tickets after 24h and `closed` is terminal.)\n' +
    '3. **No ticket at all** → fresh create (the normal new-incident path).\n\n' +
    'All tag mutations happen in a single Zendesk update call per branch.',
  [],
  { color: 5 }
);

const todoSticky = sticky(
  '## TODOs Before Activation\n\n' +
    'Edit constants at the top of `receiver.workflow.ts`:\n\n' +
    '- `GROUP_ID` — Zendesk group ID for auto-created tickets (currently `"0"`)\n' +
    '- `REQUESTER_EMAIL` — service-account email (currently `TODO_REQUESTER@example.com`)\n' +
    '- `PRIORITY` — currently `"high"` per spec default\n' +
    '- `COMMENT_PUBLIC` — currently `true` (matches Zapier zap)\n' +
    '- `RESOLVE_SUBWORKFLOW_ID` — `' + RESOLVE_SUBWORKFLOW_ID + '` (Phase 1 deployment)\n\n' +
    'Also set the env var `BETTERSTACK_WEBHOOK_TOKEN` in n8n.',
  [],
  { color: 6 }
);

// ===========================================================================
// COMPOSE
// ===========================================================================

export default workflow('betterstack-receiver', 'Betterstack → Zendesk Receiver')
  .add(webhookTrigger)
  .to(
    verifyBearerToken
      .onFalse(respondUnauthorized)
      .onTrue(
        branchByEvent
          .onCase(
            0,
            findOpenTicketResolved.to(
              resolvedTicketFound
                .onTrue(callResolveSubworkflow.to(respondResolved))
                .onFalse(formatCommentForCreate.to(createSolvedTicket.to(respondResolved)))
            )
          )
          .onCase(
            1,
            findOpenTicketAck.to(
              ackTicketFoundAndUnacked
                .onTrue(updateTicketAck.to(respondAck))
                .onFalse(ackNoOp.to(respondAck))
            )
          )
          .onCase(
            2,
            findEditableTicket.to(
              startedTicketEditable
                .onTrue(reopenTicket.to(respondStarted))
                .onFalse(
                  findClosedTicket.to(
                    closedTicketExists
                      .onTrue(createLinkedTicket.to(respondStarted))
                      .onFalse(createFreshTicket.to(respondStarted))
                  )
                )
            )
          )
      )
  )
  .add(purposeSticky)
  .add(discriminatorSticky)
  .add(ackTradeoffSticky)
  .add(resolvedEdgeSticky)
  .add(reopenSticky)
  .add(todoSticky);
