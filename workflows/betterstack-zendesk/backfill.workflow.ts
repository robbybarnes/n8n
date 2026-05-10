import {
  workflow,
  trigger,
  node,
  sticky,
  newCredential,
  ifElse,
  splitInBatches,
  nextBatch,
  expr,
} from '@n8n/workflow-sdk';

// ---------------------------------------------------------------------------
// One-off backfill workflow.
//
// Why this exists:
//   The Betterstack outgoing webhook integration is currently misrouting (or
//   silently dropping) real incident events to our receiver. Tickets that
//   should have been auto-created from `incident.started` events on
//   monitor `mrp.io` are missing, so operators have no Zendesk paper trail
//   for those incidents.
//
// What this does:
//   1. Pulls incidents from the Betterstack `/incidents` API for a fixed
//      date range (default: today, hard-coded -- edit the constants below
//      and re-validate to backfill a different window).
//   2. For each incident, checks Zendesk for an existing ticket tagged
//      `betterstack-incident-<id>` (any status, including closed).
//   3. Creates a fresh Zendesk ticket for each incident that lacks one,
//      mirroring the receiver's `createFreshTicket` config exactly. New
//      tickets carry the `betterstack-open` tag so the regular 5-minute
//      poller will pick them up and route already-resolved incidents
//      through the resolve sub-workflow within minutes.
//
// Why we DON'T duplicate the resolve-comment formatting here:
//   The resolve sub-workflow (`FXjwcoWpPhmv76ws`) already owns the
//   downtime-calculation + resolution-comment logic, gated by the
//   `betterstack-resolved` sentinel tag for idempotency. Backfilling with
//   `betterstack-open` defers all resolution work to that proven path.
//
// This is a MANUAL-trigger workflow. It is NOT scheduled, NOT activated,
// and is intended to be run ad-hoc from the n8n UI (or via the MCP
// `execute_workflow` tool) when a backfill is needed.
//
// ARCHITECTURE NOTE - per-item iteration via SplitInBatches:
//   The Code node `Extract Incidents` flattens N incidents from a single
//   HTTP-response item, so all N output items share `pairedItem: { item: 0 }`.
//   The Zendesk Search node, when fed N items, runs N queries but emits a
//   single COLLAPSED output item carrying the union of all upstream pairings
//   when results are empty. This breaks both:
//     - cross-node `.item` lookups (paired-item ambiguity), and
//     - Merge-by-position (1 search row vs N incident rows = 1 merged row).
//
//   FIX: Wrap the per-incident logic in a SplitInBatches loop with batch
//   size 1. Each iteration sees exactly 1 incident in `$json`, runs 1 search,
//   1 IF check, and either creates a ticket or no-ops. Cross-node references
//   are unambiguous because each batch is a self-contained sub-execution.
//   Root cause of execution 2684 / 2687 / 2690 failures.
// ---------------------------------------------------------------------------

const BACKFILL_FROM = '2026-05-10';
const BACKFILL_TO = '2026-05-10';
const PER_PAGE = '50';

// Routing & assignment constants -- copied from receiver.workflow.ts so the
// created tickets are indistinguishable from receiver-created ones.
const GROUP_ID = 360021265172; // Zendesk group "System Administration"
const ASSIGNEE_USER_ID = 387328728671; // Zendesk user "Robby Barnes"
const REQUESTER_USER_ID = 26045726036621; // Zendesk user "Better Stack"
const CATEGORY_FIELD_ID = 360048770292; // Zendesk Category custom field
const CATEGORY_VALUE = 'network';
const TICKET_TYPE = 'incident';
const PRIORITY = 'high';

// ===========================================================================
// TRIGGER
// ===========================================================================

const manualTriggerNode = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Manual Trigger',
    parameters: {},
    position: [240, 400],
  },
  output: [{}],
});

// ===========================================================================
// HTTP REQUEST
// ===========================================================================

const fetchIncidents = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: "Fetch Today's Incidents",
    parameters: {
      method: 'GET',
      url: 'https://uptime.betterstack.com/api/v3/incidents',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'from', value: BACKFILL_FROM },
          { name: 'to', value: BACKFILL_TO },
          { name: 'per_page', value: PER_PAGE },
        ],
      },
      options: {
        response: {
          response: {
            fullResponse: false,
            responseFormat: 'json',
          },
        },
      },
    },
    credentials: { httpHeaderAuth: newCredential('Betterstack Uptime API') },
    position: [480, 400],
  },
  output: [
    {
      data: [
        {
          id: '963298185',
          type: 'incident',
          attributes: {
            name: 'mrp.io',
            url: 'https://mrp.io',
            cause: 'HTTP 500',
            started_at: '2026-05-10T07:42:15Z',
            acknowledged_at: null,
            resolved_at: '2026-05-10T08:23:10Z',
            screenshot_url: null,
          },
        },
      ],
      pagination: { first: '...', next: null, last: '...' },
    },
  ],
});

// ===========================================================================
// CODE - flatten body.data into one item per incident
// ===========================================================================

const extractIncidentsJs = `const items = $input.all();
const out = [];
for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
  const item = items[itemIndex];
  const data = (item.json && item.json.data) || [];
  if (!Array.isArray(data)) continue;
  for (const incident of data) {
    const attrs = (incident && incident.attributes) || {};
    out.push({
      json: {
        incident_id: incident.id,
        name: attrs.name || 'Unknown monitor',
        url: attrs.url || '',
        cause: attrs.cause || '',
        started_at: attrs.started_at || '',
        acknowledged_at: attrs.acknowledged_at || null,
        resolved_at: attrs.resolved_at || null,
        screenshot_url: attrs.screenshot_url || '',
        status: attrs.status || '',
      },
      pairedItem: { item: itemIndex },
    });
  }
}
return out;`;

const extractIncidents = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Incidents',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: extractIncidentsJs,
    },
    position: [720, 400],
  },
  output: [
    {
      incident_id: '963298185',
      name: 'mrp.io',
      url: 'https://mrp.io',
      cause: 'HTTP 500',
      started_at: '2026-05-10T07:42:15Z',
      acknowledged_at: null,
      resolved_at: '2026-05-10T08:23:10Z',
      screenshot_url: '',
      status: 'Resolved',
    },
  ],
});

// ===========================================================================
// SPLIT IN BATCHES - iterate one incident at a time
// ===========================================================================

const loopOverIncidents = splitInBatches({
  version: 3,
  config: {
    name: 'Loop Over Incidents',
    parameters: { batchSize: 1 },
    position: [960, 400],
  },
});

// ===========================================================================
// ZENDESK SEARCH - check for existing ticket for THIS incident
// ===========================================================================
//
// Each iteration sees exactly 1 incident in $json. The search runs once per
// iteration. With `alwaysOutputData: true`, an empty result still emits a
// single `{}` item, so the IF below can evaluate it.

const findExistingTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Existing Ticket?',
    parameters: {
      resource: 'ticket',
      operation: 'getAll',
      returnAll: false,
      limit: 1,
      options: {
        query: expr(
          '={{ "tags:betterstack-incident-" + $(\'Loop Over Incidents\').item.json.incident_id }}'
        ),
      },
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    alwaysOutputData: true,
    position: [1200, 400],
  },
  output: [{}],
});

// ===========================================================================
// IF - does the search return an actual ticket?
// ===========================================================================

const ticketExists = ifElse({
  version: 2.3,
  config: {
    name: 'Ticket Exists?',
    parameters: {
      conditions: {
        options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'loose' },
        combinator: 'and',
        conditions: [
          {
            id: 'has-ticket',
            leftValue: expr('{{ $json.id }}'),
            rightValue: 0,
            operator: { type: 'number', operation: 'gt' },
          },
        ],
      },
      options: { looseTypeValidation: true },
    },
    position: [1440, 400],
  },
});

// ===========================================================================
// ZENDESK CREATE - backfill ticket for THIS incident
// ===========================================================================

const backfillDescriptionExpression =
  '={{ "Monitor: " + $(\'Loop Over Incidents\').item.json.name + "\\nURL: " + ($(\'Loop Over Incidents\').item.json.url || "n/a") + "\\nCause: " + ($(\'Loop Over Incidents\').item.json.cause || "Not specified") + "\\nStarted at: " + ($(\'Loop Over Incidents\').item.json.started_at || "unknown") + ($(\'Loop Over Incidents\').item.json.screenshot_url ? ("\\nScreenshot: " + $(\'Loop Over Incidents\').item.json.screenshot_url) : "") }}';

const backfillAdditionalFieldsExpression =
  '={{ JSON.stringify({ subject: "[Betterstack] " + $(\'Loop Over Incidents\').item.json.name + " is down", status: "open", type: ' +
  JSON.stringify(TICKET_TYPE) +
  ', priority: ' +
  JSON.stringify(PRIORITY) +
  ', group_id: ' +
  JSON.stringify(GROUP_ID) +
  ', assignee_id: ' +
  JSON.stringify(ASSIGNEE_USER_ID) +
  ', requester_id: ' +
  JSON.stringify(REQUESTER_USER_ID) +
  ', tags: ["betterstack-incident-" + $(\'Loop Over Incidents\').item.json.incident_id, "betterstack-open", "automated", "backfill"], custom_fields: [{ id: ' +
  JSON.stringify(CATEGORY_FIELD_ID) +
  ', value: ' +
  JSON.stringify(CATEGORY_VALUE) +
  ' }] }) }}';

const createBackfillTicket = node({
  type: 'n8n-nodes-base.zendesk',
  version: 1,
  config: {
    name: 'Create Backfill Ticket',
    parameters: {
      resource: 'ticket',
      operation: 'create',
      description: expr(backfillDescriptionExpression),
      jsonParameters: true,
      additionalFieldsJson: expr(backfillAdditionalFieldsExpression),
    },
    credentials: { zendeskApi: newCredential('Zendesk account') },
    position: [1680, 520],
  },
  output: [
    {
      id: 99999,
      status: 'open',
      tags: ['betterstack-incident-963298185', 'betterstack-open', 'automated', 'backfill'],
    },
  ],
});

// Skip path on existing ticket -- still has to feed back into nextBatch so the
// loop continues even when we no-op for an already-existing ticket.
const skipExistingNoOp = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: {
    name: 'Skip (Ticket Exists)',
    parameters: {},
    position: [1680, 280],
  },
  output: [{ skipped: true, reason: 'ticket already exists for this incident' }],
});

// Final aggregation node after the loop completes.
const doneNoOp = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: {
    name: 'Backfill Complete',
    parameters: {},
    position: [1200, 200],
  },
  output: [{ done: true }],
});

// ===========================================================================
// STICKY NOTES
// ===========================================================================

const purposeSticky = sticky(
  '## Betterstack -> Zendesk Backfill (One-off)\n\n' +
    '**Trigger**: Manual only.\n' +
    '**Window**: ' + BACKFILL_FROM + ' to ' + BACKFILL_TO + ' (inclusive).\n' +
    'Edit the constants in backfill.workflow.ts to change the window.',
  [],
  { color: 4 }
);

const architectureSticky = sticky(
  '## Why the SplitInBatches loop?\n\n' +
    'The Code node flattens N incidents from one HTTP item, so all share\n' +
    'pairedItem item:0. The Zendesk Search collapses 0-result queries to one\n' +
    'empty item with the union of upstream pairings. Cross-node\n' +
    '$(Extract Incidents).item lookups then fail with Multiple matches found.\n\n' +
    'Fix: SplitInBatches with batch size 1. Each iteration is a self-contained\n' +
    'sub-execution -- 1 incident in, 1 search out, unambiguous lookups.',
  [],
  { color: 5 }
);

const tagsSticky = sticky(
  '## Tags\n\n' +
    'betterstack-incident-<id>, betterstack-open, automated, backfill.\n' +
    'The poller picks up tickets via betterstack-open and resolves them.',
  [],
  { color: 3 }
);

// ===========================================================================
// COMPOSE
// ===========================================================================

export default workflow('betterstack-backfill', 'Betterstack -> Zendesk Backfill (One-off)')
  .add(manualTriggerNode)
  .to(fetchIncidents)
  .to(extractIncidents)
  .to(
    loopOverIncidents
      .onDone(doneNoOp)
      .onEachBatch(
        findExistingTicket.to(
          ticketExists
            .onTrue(skipExistingNoOp.to(nextBatch(loopOverIncidents)))
            .onFalse(createBackfillTicket.to(nextBatch(loopOverIncidents)))
        )
      )
  )
  .add(purposeSticky)
  .add(architectureSticky)
  .add(tagsSticky);
