import {
  workflow,
  trigger,
  node,
  sticky,
  newCredential,
  ifElse,
  switchCase,
  splitInBatches,
  nextBatch,
  expr,
} from '@n8n/workflow-sdk';

// ---------------------------------------------------------------------------
// Constants — baked in at workflow-compile time. Editing requires
// re-validating + redeploying the workflow.
// ---------------------------------------------------------------------------
const RESOLVE_SUBWORKFLOW_ID = 'FXjwcoWpPhmv76ws'; // Phase 1 resolve sub-workflow
const POLL_INTERVAL_MINUTES = 5;
const HTTP_MAX_TRIES = 3;
const HTTP_RETRY_WAIT_MS = 2000;

// ===========================================================================
// TRIGGER: schedule every 5 min
// ===========================================================================

const scheduleTriggerNode = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 5 Minutes',
    parameters: {
      rule: {
        interval: [{ field: 'minutes', minutesInterval: POLL_INTERVAL_MINUTES }],
      },
    },
    position: [240, 400],
  },
  output: [{}],
});

// ===========================================================================
// ZENDESK SEARCH: find tickets needing reconciliation
// ===========================================================================

const findOpenBetterstackTickets = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Find Open Betterstack Tickets',
    parameters: {
      resource: 'ticket',
      operation: 'getAll',
      returnAll: true,
      options: {
        query: 'tags:betterstack-open status<solved',
      },
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    // Always emit at least one item so SplitInBatches/downstream nodes
    // run a no-op iteration cycle even when there are zero open tickets.
    // Without this, the entire chain is skipped silently, which makes
    // the workflow look broken in the executions log on quiet cycles.
    alwaysOutputData: true,
    position: [480, 400],
  },
  output: [
    {
      id: 12345,
      status: 'open',
      tags: ['betterstack-incident-inc-abc-123', 'betterstack-open', 'automated'],
    },
  ],
});

// ===========================================================================
// SPLIT IN BATCHES: iterate one ticket at a time
// ===========================================================================

const ticketLoop = splitInBatches({
  version: 3,
  config: {
    name: 'Loop Tickets',
    parameters: { batchSize: 1 },
    position: [720, 400],
  },
});

// ===========================================================================
// EXTRACT INCIDENT ID FROM TAG
// ===========================================================================

const extractIncidentIdJs = `const items = $input.all();
const out = [];
for (const item of items) {
  const ticket = item.json;
  const tag = (ticket.tags || []).find(function(t) {
    return typeof t === 'string' && t.indexOf('betterstack-incident-') === 0;
  });
  if (!tag) {
    out.push({
      json: {
        skip: true,
        reason: 'no betterstack-incident-* tag on ticket',
        ticket_id: ticket.id,
        ticket_tags: ticket.tags || [],
      }
    });
    continue;
  }
  const incidentId = tag.substring('betterstack-incident-'.length);
  out.push({
    json: {
      skip: false,
      incident_id: incidentId,
      ticket_id: ticket.id,
      ticket_tags: ticket.tags || [],
    }
  });
}
return out;`;

const extractIncidentId = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Incident ID',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: extractIncidentIdJs,
    },
    position: [960, 520],
  },
  output: [
    {
      skip: false,
      incident_id: 'inc-abc-123',
      ticket_id: 12345,
      ticket_tags: ['betterstack-incident-inc-abc-123', 'betterstack-open', 'automated'],
    },
  ],
});

// ===========================================================================
// IF: skip tickets with no betterstack-incident-* tag
// ===========================================================================

const skipCheck = ifElse({
  version: 2.3,
  config: {
    name: 'Skip?',
    parameters: {
      conditions: {
        options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'loose' },
        combinator: 'and',
        conditions: [
          {
            id: 'has-skip-flag',
            leftValue: expr('{{ $json.skip }}'),
            rightValue: true,
            operator: { type: 'boolean', operation: 'equals' },
          },
        ],
      },
      options: { looseTypeValidation: true },
    },
    position: [1200, 520],
  },
});

const skipNoOp = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: {
    name: 'Skip (Missing Tag)',
    parameters: {},
    position: [1440, 400],
  },
  output: [{ skipped: true, reason: 'no betterstack-incident-* tag' }],
});

// ===========================================================================
// HTTP REQUEST: GET Betterstack incident
// ===========================================================================
//
// Failure handling:
//   - `neverError: true` makes the HTTP node succeed on 4xx/5xx, surfacing
//     the response body alongside `statusCode`.
//   - `fullResponse: true` exposes `statusCode`, `headers`, and `body` on the
//     output object so the Switch downstream can branch on the status.
//   - `retryOnFail` + `maxTries` + `waitBetweenTries` are n8n's standard
//     node-level retry settings for transient network/5xx failures (the HTTP
//     node still treats those as errors *before* `neverError` kicks in,
//     because retry runs at the node level, not the response level).

const getBetterstackIncident = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Get Betterstack Incident',
    parameters: {
      method: 'GET',
      url: expr(
        '={{ "https://uptime.betterstack.com/api/v3/incidents/" + $json.incident_id }}'
      ),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {
        response: {
          response: {
            fullResponse: true,
            neverError: true,
            responseFormat: 'json',
          },
        },
      },
    },
    credentials: { httpHeaderAuth: newCredential('Betterstack Uptime API') },
    retryOnFail: true,
    maxTries: HTTP_MAX_TRIES,
    waitBetweenTries: HTTP_RETRY_WAIT_MS,
    position: [1440, 640],
  },
  output: [
    {
      statusCode: 200,
      headers: {},
      body: {
        data: {
          id: 'inc-abc-123',
          type: 'incident',
          attributes: {
            name: 'Example Monitor',
            url: 'https://example.com',
            cause: 'HTTP 500',
            started_at: '2026-05-09T10:00:00Z',
            acknowledged_at: '2026-05-09T10:01:00Z',
            resolved_at: '2026-05-09T10:05:30Z',
            status: 'Resolved',
          },
        },
      },
    },
  ],
});

// ===========================================================================
// SWITCH: branch by Betterstack status / 404
// ===========================================================================

const statusBranch = switchCase({
  version: 3.4,
  config: {
    name: 'Status Branch',
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
                  leftValue: expr('{{ $json.body.data.attributes.status }}'),
                  rightValue: 'Resolved',
                  operator: { type: 'string', operation: 'equals' },
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
                  id: 'is-404',
                  leftValue: expr('{{ $json.statusCode }}'),
                  rightValue: 404,
                  operator: { type: 'number', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: '404',
          },
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'still-open', allMatchingOutputs: false },
    },
    position: [1680, 640],
  },
});

// ===========================================================================
// RESOLVED BRANCH (output 0): call resolve sub-workflow
// ===========================================================================

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
          // Wrap in String() — the resolve sub-workflow's input schema
          // declares zendesk_ticket_id as a string. Zendesk returns it as a
          // number, so without coercion ExecuteWorkflow throws ExpressionError.
          zendesk_ticket_id: expr(
            "={{ String($('Extract Incident ID').item.json.ticket_id) }}"
          ),
          incident_id: expr(
            "={{ $('Extract Incident ID').item.json.incident_id }}"
          ),
          incident: expr(
            '={{ $(\'Get Betterstack Incident\').item.json.body.data.attributes }}'
          ),
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
    position: [1920, 480],
  },
  output: [{ resolved: true }],
});

// ===========================================================================
// 404 BRANCH (output 1): strip betterstack-open tag + add internal comment
// ===========================================================================
//
// Defensive (... || []).filter(...) pattern + JSON.stringify for the body
// matches the receiver's reopen-update style. comment.public=false because
// the explanatory note is for operators, not the requester.

const notFoundUpdateExpression =
  '={{ JSON.stringify({ tags: ($(\'Extract Incident ID\').item.json.ticket_tags || []).filter(function(t) { return t !== "betterstack-open"; }), comment: { body: "Underlying Betterstack incident no longer exists; clearing automation tag.", public: false } }) }}';

const stripOpenTag = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Strip betterstack-open Tag',
    parameters: {
      resource: 'ticket',
      operation: 'update',
      id: expr("={{ $('Extract Incident ID').item.json.ticket_id }}"),
      jsonParameters: true,
      updateFieldsJson: expr(notFoundUpdateExpression),
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [1920, 720],
  },
  output: [
    {
      id: 12345,
      status: 'open',
      tags: ['betterstack-incident-inc-abc-123', 'automated'],
    },
  ],
});

// ===========================================================================
// STILL-OPEN BRANCH (fallback output): no-op, recheck next cycle
// ===========================================================================

const stillOpenNoOp = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: {
    name: 'Still Open (No-op)',
    parameters: {},
    position: [1920, 960],
  },
  output: [{ skipped: true, reason: 'incident not yet resolved' }],
});

// ===========================================================================
// LOOP CONTINUATIONS: each terminal in the per-ticket flow returns to the
// SplitInBatches loop so it advances to the next ticket. nextBatch() is the
// SDK helper that wires this loop-back for us.
// ===========================================================================

const loopBackResolved = nextBatch(ticketLoop);
const loopBack404 = nextBatch(ticketLoop);
const loopBackStillOpen = nextBatch(ticketLoop);
const loopBackSkip = nextBatch(ticketLoop);

// ===========================================================================
// LOOP DONE
// ===========================================================================

const loopDone = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: {
    name: 'Loop Done',
    parameters: {},
    position: [960, 280],
  },
  output: [{ done: true }],
});

// ===========================================================================
// STICKY NOTES
// ===========================================================================

const purposeSticky = sticky(
  '## Betterstack → Zendesk Poller\n\n' +
    '**Cadence**: every ' + POLL_INTERVAL_MINUTES + ' minutes.\n\n' +
    '**Scope query**: `tags:betterstack-open status<solved`. Returns at most\n' +
    'a handful of tickets in steady state — there is nothing to scan when no\n' +
    'incidents are open.\n\n' +
    '**Purpose**: Catches resolved-event webhooks that the receiver missed\n' +
    '(network blip, n8n restart, Betterstack delivery glitch, etc.). Both\n' +
    'paths converge on the same resolve sub-workflow `' + RESOLVE_SUBWORKFLOW_ID +
    '`, which is idempotent via the `betterstack-resolved` sentinel tag.\n\n' +
    '**Spec**: `docs/superpowers/specs/2026-05-09-betterstack-zendesk-incident-workflow-design.md`',
  [],
  { color: 4 }
);

const httpHandlingSticky = sticky(
  '## HTTP Request Resilience\n\n' +
    '`Get Betterstack Incident` is configured to:\n\n' +
    '- `neverError: true` + `fullResponse: true` — the node succeeds on 4xx/5xx\n' +
    '  and exposes `statusCode`, `headers`, `body` to downstream nodes. The\n' +
    '  Switch then routes 200+Resolved to the resolve path, 404 to the strip-\n' +
    '  tag path, and everything else to the still-open no-op.\n' +
    '- `retryOnFail: true`, `maxTries: ' + HTTP_MAX_TRIES + '`,\n' +
    '  `waitBetweenTries: ' + HTTP_RETRY_WAIT_MS + 'ms` — n8n\'s native node-\n' +
    '  level retry. Note: this fires on transport errors (DNS, TLS, timeout)\n' +
    '  but NOT on HTTP 4xx/5xx, because `neverError` already promotes those\n' +
    '  to "successful" responses. That\'s the right trade-off here — a 404 is\n' +
    '  a deliberate signal (incident deleted), not a transient failure to retry.\n\n' +
    '**5xx behavior — known limitation**: a sustained Betterstack outage (5xx\n' +
    'on every poll) will silently no-op via the still-open fallback for as long\n' +
    'as the outage lasts. The ticket retains `betterstack-open`, so polling\n' +
    'resumes naturally once Betterstack recovers. Acceptable for current low\n' +
    'volume; if scaling up, add a Switch branch for `statusCode >= 500` that\n' +
    'posts to Slack via the error-notification workflow.\n\n' +
    '**Credential type**: this node uses `genericAuthType: "httpHeaderAuth"`\n' +
    'with credential `Betterstack Uptime API` (Authorization = Bearer <token>).\n' +
    'Do not swap to a different auth type without re-deploying — the node\n' +
    'config encodes the type, not just the credential reference.\n\n' +
    '**Rate limits**: Betterstack does not publish a numeric rate limit. At\n' +
    'typical N (0-5 open Betterstack-originated tickets) this workflow makes\n' +
    'one Zendesk Search + N Betterstack GETs per ' + POLL_INTERVAL_MINUTES +
    ' minutes — well within any reasonable rate budget.',
  [],
  { color: 5 }
);

const fourOhFourSticky = sticky(
  '## 404 Handling Rationale\n\n' +
    'A 404 from `GET /api/v3/incidents/<id>` means the incident was deleted on\n' +
    'the Betterstack side. The ticket on our side still claims `betterstack-open`,\n' +
    'so the poller would otherwise re-poll it forever.\n\n' +
    'Resolution: remove only `betterstack-open` (preserve `betterstack-incident-<id>`\n' +
    'so the audit trail survives) and append an internal comment explaining the\n' +
    'tag clearance. The ticket stays in its current status — operators close it\n' +
    'manually if appropriate.\n\n' +
    'We do NOT call the resolve sub-workflow in this case: there is no Betterstack\n' +
    '`resolved_at` to record, so the downtime calculation would be wrong.',
  [],
  { color: 5 }
);

const idempotencySticky = sticky(
  '## Idempotency\n\n' +
    'Every resolve action is gated by the `betterstack-resolved` tag inside the\n' +
    'resolve sub-workflow. If the receiver and the poller race to resolve the\n' +
    'same ticket, whichever wins sets the sentinel and the loser no-ops on its\n' +
    'next pass.\n\n' +
    'The 404 strip-tag path is also naturally idempotent: once `betterstack-open`\n' +
    'is gone, the Zendesk Search no longer returns the ticket, so the workflow\n' +
    'stops touching it.',
  [],
  { color: 5 }
);

// ===========================================================================
// COMPOSE
// ===========================================================================

export default workflow('betterstack-poller', 'Betterstack → Zendesk Poller')
  .add(scheduleTriggerNode)
  .to(findOpenBetterstackTickets)
  .to(
    ticketLoop
      .onDone(loopDone)
      .onEachBatch(
        extractIncidentId.to(
          skipCheck
            .onTrue(skipNoOp.to(loopBackSkip))
            .onFalse(
              getBetterstackIncident.to(
                statusBranch
                  .onCase(0, callResolveSubworkflow.to(loopBackResolved))
                  .onCase(1, stripOpenTag.to(loopBack404))
                  .onCase(2, stillOpenNoOp.to(loopBackStillOpen))
              )
            )
        )
      )
  )
  .add(purposeSticky)
  .add(httpHandlingSticky)
  .add(fourOhFourSticky)
  .add(idempotencySticky);
