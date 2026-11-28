import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  APP_NAME,
  BulkCardUpdateItemSchema,
  BulkPriorityUpdateItemSchema,
  CardStatusSchema,
  CreateChecklistInputSchema,
  EntityIdSchema,
  EventTypeSchema,
  IsoDateTimeSchema,
  NormalizedTagsSchema,
  NoteSchema,
  RecurrenceSchema,
  SHARED_VERSION,
  SmartQueryTypeSchema,
  SubscriptionFiltersSchema,
  WebhookAuthTypeSchema,
} from '@agent-kanban/shared';
import { z } from 'zod';
import {
  archiveCardHandler,
  changeCardStatusHandler,
  completeCardHandler,
  createCardHandler,
  getCardByIdHandler,
  getCardByTrelloHandler,
  listCardActivityHandler,
  listCardsHandler,
  listGlobalActivityHandler,
  listRecurringCardsHandler,
  rescoreCardHandler,
  searchCardsHandler,
  updateCardHandler,
} from '../handlers/cards.js';
import {
  addCardLinkHandler,
  addChecklistItemHandler,
  createChecklistHandler,
  deleteCardLinkHandler,
  deleteChecklistHandler,
  deleteChecklistItemHandler,
  updateChecklistHandler,
  updateChecklistItemHandler,
} from '../handlers/checklists.js';
import { createCardCommentHandler } from '../handlers/comments.js';
import { listEventsHandler } from '../handlers/events.js';
import {
  bulkCompleteCardsHandler,
  bulkUpdateCardsHandler,
  bulkUpdatePrioritiesHandler,
  smartQueryCardsHandler,
  workspaceSnapshotHandler,
} from '../handlers/priorities.js';
import {
  createSubscriptionHandler,
  deleteSubscriptionHandler,
  listSubscriptionsHandler,
  updateSubscriptionHandler,
} from '../handlers/subscriptions.js';
import { listTagsHandler } from '../handlers/tags.js';
import { AppError } from '../lib/errors.js';
import type { AuthContext } from '../types/express.js';

export interface CreateMcpServerOptions {
  headerAgentName?: string;
  householdTimezone?: string;
}

const MAX_AGENT_NAME_LENGTH = 120;

/**
 * Stamps `actorType: 'agent'` on every `/mcp` invocation (including OAuth 2.1 JWT
 * callers) so MCP writes obey agent attribution and loop suppression.
 */
export function toMcpAgentAuth(
  baseAuth: AuthContext,
  headerAgentName?: string,
  argAgentName?: string,
): AuthContext {
  const resolvedAgentName = (
    argAgentName?.trim() ||
    headerAgentName?.trim() ||
    baseAuth.agentName?.trim() ||
    'MCP Client'
  ).slice(0, MAX_AGENT_NAME_LENGTH);
  const resolvedPlatform = (baseAuth.platform?.trim() || 'MCP').slice(0, MAX_AGENT_NAME_LENGTH);

  return {
    ...baseAuth,
    actorType: 'agent',
    agentName: resolvedAgentName,
    platform: resolvedPlatform,
  };
}

function okToolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function errorToolResult(error: unknown) {
  if (error instanceof AppError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: {
              code: error.code,
              message: error.message,
              ...(error.details !== undefined ? { details: error.details } : {}),
            },
          }),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Unexpected tool execution error',
          },
        }),
      },
    ],
  };
}

async function runTool(fn: () => Promise<unknown>) {
  try {
    return okToolResult(await fn());
  } catch (error) {
    return errorToolResult(error);
  }
}

export function createMcpServer(
  baseAuth: AuthContext,
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: APP_NAME,
    version: SHARED_VERSION,
  });

  const agentAuth = (argAgentName?: string) =>
    toMcpAgentAuth(baseAuth, options.headerAgentName, argAgentName);

  // 1. list_cards
  server.registerTool(
    'list_cards',
    {
      description:
        'List visible cards filtered by status, tag, assignee, aware user, or due window.',
      inputSchema: {
        status: z.string().optional(),
        tag: z.string().optional(),
        assignedTo: EntityIdSchema.optional(),
        awareOf: EntityIdSchema.optional(),
        dueBefore: z.string().optional(),
        dueAfter: z.string().optional(),
        updatedSince: z.string().optional(),
        archived: z.enum(['true', 'false', 'all']).optional(),
        sort: z.enum(['priority', 'updated']).optional(),
        includeDeferred: z.enum(['true', 'false']).optional(),
        hasRecurrence: z.enum(['true', 'false']).optional(),
      },
    },
    async (args) => runTool(() => listCardsHandler(agentAuth(), args)),
  );

  server.registerTool(
    'list_recurring_cards',
    {
      description:
        'List visible non-archived recurring cards with projected occurrences, cadence, and effective lead days, plus currently deferred non-recurring cards.',
      inputSchema: {
        horizonDays: z.number().int().min(1).max(366).optional(),
      },
    },
    async (args) =>
      runTool(() =>
        listRecurringCardsHandler(agentAuth(), args, {
          householdTimezone: options.householdTimezone,
        }),
      ),
  );

  // 2. get_card
  server.registerTool(
    'get_card',
    {
      description: 'Fetch a single visible card by ID.',
      inputSchema: {
        cardId: EntityIdSchema,
      },
    },
    async ({ cardId }) => runTool(() => getCardByIdHandler(agentAuth(), cardId)),
  );

  // 3. get_card_by_trello
  server.registerTool(
    'get_card_by_trello',
    {
      description: 'Resolve a legacy Trello card URL or shortLink among visible cards.',
      inputSchema: {
        url: z.string().optional(),
        shortLink: z.string().optional(),
      },
    },
    async (args) => runTool(() => getCardByTrelloHandler(agentAuth(), args)),
  );

  // 4. search_cards
  server.registerTool(
    'search_cards',
    {
      description: 'Full-text token search across card titles, descriptions, and checklist items.',
      inputSchema: {
        q: z.string().trim().min(1),
        archived: z.enum(['true', 'false', 'all']).optional(),
      },
    },
    async (args) => runTool(() => searchCardsHandler(agentAuth(), args)),
  );

  // 5. get_workspace_snapshot
  server.registerTool(
    'get_workspace_snapshot',
    {
      description:
        'Single-call workspace snapshot of all open visible cards with dues, checklists, counts, and latest comment.',
      inputSchema: {},
    },
    async () =>
      runTool(() =>
        workspaceSnapshotHandler(agentAuth(), {
          householdTimezone: options.householdTimezone,
        }),
      ),
  );

  server.registerTool(
    'list_tags',
    {
      description:
        'List the visibility-scoped tag vocabulary with open counts, total counts, and last-used timestamps.',
      inputSchema: {
        includeArchived: z.boolean().optional(),
      },
    },
    async (args) => runTool(() => listTagsHandler(agentAuth(), args)),
  );

  // 6. smart_query_cards
  server.registerTool(
    'smart_query_cards',
    {
      description:
        'Run a smart query (`overdue_or_due_within_days`, `stale_in_todo_days`, or `upcoming_recurring`) on visible cards.',
      inputSchema: {
        query: SmartQueryTypeSchema,
        days: z.number().int().min(0).max(3650).optional(),
      },
    },
    async (args) =>
      runTool(() =>
        smartQueryCardsHandler(agentAuth(), args, {
          householdTimezone: options.householdTimezone,
        }),
      ),
  );

  // 7. get_activity
  server.registerTool(
    'get_activity',
    {
      description: 'List paginated activity log entries for a specific card or globally.',
      inputSchema: {
        cardId: EntityIdSchema.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ cardId, ...pagination }) =>
      runTool(() =>
        cardId
          ? listCardActivityHandler(agentAuth(), cardId, pagination)
          : listGlobalActivityHandler(agentAuth(), pagination),
      ),
  );

  // 8. create_card
  server.registerTool(
    'create_card',
    {
      description: 'Create a new card.',
      inputSchema: {
        title: z.string().trim().min(1).max(300),
        description: z.string().max(20000).optional(),
        status: CardStatusSchema.optional(),
        tags: NormalizedTagsSchema.optional(),
        assignedUserIds: z.array(EntityIdSchema).optional(),
        awareUserIds: z.array(EntityIdSchema).optional(),
        priorityScore: z.number().min(0).max(100).nullable().optional(),
        priorityReason: z.string().trim().min(1).max(500).nullable().optional(),
        due: IsoDateTimeSchema.nullable().optional(),
        dueFirm: z.boolean().optional(),
        dueHasTime: z.boolean().optional(),
        recurrence: RecurrenceSchema.nullable().optional(),
        pinned: z.boolean().optional(),
        deferUntil: IsoDateTimeSchema.nullable().optional(),
        links: z
          .array(z.object({ url: z.string().url(), label: z.string().optional() }))
          .optional(),
        checklists: z.array(CreateChecklistInputSchema).optional(),
        trelloUrl: z.string().url().nullable().optional(),
        trelloShortLink: z.string().nullable().optional(),
        idempotencyKey: z.string().optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ idempotencyKey, agentName, ...body }) =>
      runTool(async () => {
        const res = await createCardHandler(agentAuth(agentName), body, { idempotencyKey });
        return { ...res.body, replayed: res.replayed };
      }),
  );

  // 9. update_card
  server.registerTool(
    'update_card',
    {
      description: 'Update card fields with optional `ifUpdatedAt` precondition.',
      inputSchema: {
        cardId: EntityIdSchema,
        title: z.string().trim().min(1).max(300).optional(),
        description: z.string().max(20000).optional(),
        status: CardStatusSchema.optional(),
        tags: NormalizedTagsSchema.optional(),
        assignedUserIds: z.array(EntityIdSchema).optional(),
        awareUserIds: z.array(EntityIdSchema).optional(),
        priorityScore: z.number().min(0).max(100).nullable().optional(),
        priorityReason: z.string().trim().min(1).max(500).nullable().optional(),
        due: IsoDateTimeSchema.nullable().optional(),
        dueFirm: z.boolean().optional(),
        dueHasTime: z.boolean().optional(),
        recurrence: RecurrenceSchema.nullable().optional(),
        pinned: z.boolean().optional(),
        deferUntil: IsoDateTimeSchema.nullable().optional(),
        archived: z.boolean().optional(),
        trelloUrl: z.string().url().nullable().optional(),
        trelloShortLink: z.string().nullable().optional(),
        ifUpdatedAt: IsoDateTimeSchema.optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ cardId, agentName, ...body }) =>
      runTool(() => updateCardHandler(agentAuth(agentName), cardId, body)),
  );

  // 10. change_card_status
  server.registerTool(
    'change_card_status',
    {
      description: 'Change a card status between todo, doing, blocked, and done.',
      inputSchema: {
        cardId: EntityIdSchema,
        status: CardStatusSchema,
        ifUpdatedAt: IsoDateTimeSchema.optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ cardId, agentName, ...body }) =>
      runTool(() => changeCardStatusHandler(agentAuth(agentName), cardId, body)),
  );

  // 11. complete_card
  server.registerTool(
    'complete_card',
    {
      description:
        'Complete a card (moves non-recurring cards to done, resets recurring cards in-place).',
      inputSchema: {
        cardId: EntityIdSchema,
        ifUpdatedAt: IsoDateTimeSchema.optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ cardId, agentName, ...body }) =>
      runTool(() =>
        completeCardHandler(agentAuth(agentName), cardId, body, {
          householdTimezone: options.householdTimezone,
        }),
      ),
  );

  server.registerTool(
    'request_card_rescore',
    {
      description:
        'Clear priorityScore and priorityReason and log a rescore request. Human callers emit card.rescore_requested; agent callers do not.',
      inputSchema: {
        cardId: EntityIdSchema,
        ifUpdatedAt: IsoDateTimeSchema.optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ cardId, agentName, ...body }) =>
      runTool(() => rescoreCardHandler(agentAuth(agentName), cardId, body)),
  );

  // 12. archive_card
  server.registerTool(
    'archive_card',
    {
      description: 'Archive or unarchive a card.',
      inputSchema: {
        cardId: EntityIdSchema,
        archived: z.boolean().optional(),
        ifUpdatedAt: IsoDateTimeSchema.optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ cardId, agentName, ...body }) =>
      runTool(() => archiveCardHandler(agentAuth(agentName), cardId, body)),
  );

  // 13. bulk_update_priorities
  server.registerTool(
    'bulk_update_priorities',
    {
      description:
        'Atomically update priorityScore and priorityReason across multiple visible cards.',
      inputSchema: {
        updates: z.array(BulkPriorityUpdateItemSchema).min(1).max(200),
        idempotencyKey: z.string().optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ idempotencyKey, agentName, ...body }) =>
      runTool(async () => {
        const res = await bulkUpdatePrioritiesHandler(agentAuth(agentName), body, {
          idempotencyKey,
        });
        return { ...res.body, replayed: res.replayed };
      }),
  );

  // 14. bulk_update_cards
  server.registerTool(
    'bulk_update_cards',
    {
      description:
        'Atomically update status, tags, due, archive, assignees, deferUntil, pinned, or rescore across visible cards. Recurring cards cannot be set to done; use bulk_complete_cards.',
      inputSchema: {
        updates: z.array(BulkCardUpdateItemSchema).min(1).max(200),
        idempotencyKey: z.string().optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ idempotencyKey, agentName, ...body }) =>
      runTool(async () => {
        const res = await bulkUpdateCardsHandler(agentAuth(agentName), body, { idempotencyKey });
        return { ...res.body, replayed: res.replayed };
      }),
  );

  server.registerTool(
    'bulk_complete_cards',
    {
      description:
        'Atomically complete visible cards. Non-recurring cards are marked done. Recurring cards reset in place with the next due date, unchecked checklists, and auto-defer.',
      inputSchema: {
        cardIds: z.array(EntityIdSchema).min(1).max(200),
        idempotencyKey: z.string().optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ idempotencyKey, agentName, ...body }) =>
      runTool(async () => {
        const res = await bulkCompleteCardsHandler(agentAuth(agentName), body, {
          idempotencyKey,
          householdTimezone: options.householdTimezone,
        });
        return { ...res.body, replayed: res.replayed };
      }),
  );

  // 15. add_comment
  server.registerTool(
    'add_comment',
    {
      description: 'Post a comment on a card (automatically resolves @handle mentions).',
      inputSchema: {
        cardId: EntityIdSchema,
        text: z.string().trim().min(1).max(10000),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ cardId, agentName, ...body }) =>
      runTool(() => createCardCommentHandler(agentAuth(agentName), cardId, body)),
  );

  // 16. manage_checklist
  server.registerTool(
    'manage_checklist',
    {
      description: 'Create, update, or delete checklists and checklist items on a card.',
      inputSchema: {
        action: z.enum([
          'create_checklist',
          'update_checklist',
          'delete_checklist',
          'add_item',
          'update_item',
          'delete_item',
        ]),
        cardId: EntityIdSchema,
        checklistId: EntityIdSchema.optional(),
        itemId: EntityIdSchema.optional(),
        title: z.string().trim().min(1).max(200).optional(),
        items: z
          .array(
            z.object({
              id: EntityIdSchema.optional(),
              text: z.string().trim().min(1).max(500),
              checked: z.boolean().optional(),
            }),
          )
          .optional(),
        text: z.string().trim().min(1).max(500).optional(),
        checked: z.boolean().optional(),
        ifUpdatedAt: IsoDateTimeSchema.optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ action, cardId, checklistId, itemId, agentName, ...rest }) =>
      runTool(() => {
        const auth = agentAuth(agentName);
        switch (action) {
          case 'create_checklist':
            return createChecklistHandler(auth, cardId, rest);
          case 'update_checklist':
            return updateChecklistHandler(auth, cardId, checklistId, rest);
          case 'delete_checklist':
            return deleteChecklistHandler(auth, cardId, checklistId, rest);
          case 'add_item':
            return addChecklistItemHandler(auth, cardId, checklistId, rest);
          case 'update_item':
            return updateChecklistItemHandler(auth, cardId, checklistId, itemId, rest);
          case 'delete_item':
            return deleteChecklistItemHandler(auth, cardId, checklistId, itemId, rest);
        }
      }),
  );

  // 17. toggle_checklist_item
  server.registerTool(
    'toggle_checklist_item',
    {
      description: 'Toggle `checked` or update `text` on a checklist item.',
      inputSchema: {
        cardId: EntityIdSchema,
        checklistId: EntityIdSchema,
        itemId: EntityIdSchema,
        checked: z.boolean().optional(),
        text: z.string().trim().min(1).max(500).optional(),
        ifUpdatedAt: IsoDateTimeSchema.optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ cardId, checklistId, itemId, agentName, ...body }) =>
      runTool(() =>
        updateChecklistItemHandler(agentAuth(agentName), cardId, checklistId, itemId, body),
      ),
  );

  // 18. manage_link
  server.registerTool(
    'manage_link',
    {
      description: 'Add or remove an HTTP/HTTPS link attachment on a card.',
      inputSchema: {
        action: z.enum(['add', 'delete']),
        cardId: EntityIdSchema,
        linkId: EntityIdSchema.optional(),
        url: z.string().url().optional(),
        label: z.string().trim().min(1).max(200).optional(),
        ifUpdatedAt: IsoDateTimeSchema.optional(),
        note: NoteSchema.optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ action, cardId, linkId, agentName, ...rest }) =>
      runTool(() => {
        const auth = agentAuth(agentName);
        if (action === 'add') {
          return addCardLinkHandler(auth, cardId, rest);
        }
        return deleteCardLinkHandler(auth, cardId, linkId, rest);
      }),
  );

  // 19. list_events
  server.registerTool(
    'list_events',
    {
      description: 'Poll visible domain events incrementally using `since` cursor.',
      inputSchema: {
        since: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        type: EventTypeSchema.optional(),
      },
    },
    async (args) => runTool(() => listEventsHandler(agentAuth(), args)),
  );

  // 20. manage_subscriptions
  server.registerTool(
    'manage_subscriptions',
    {
      description: 'List, create, update, or delete filtered webhook subscriptions.',
      inputSchema: {
        action: z.enum(['list', 'create', 'update', 'delete']),
        subscriptionId: EntityIdSchema.optional(),
        connectionId: EntityIdSchema.nullable().optional(),
        webhookUrl: z.string().url().optional(),
        authType: WebhookAuthTypeSchema.optional(),
        secret: z.string().min(16).max(512).optional(),
        filters: SubscriptionFiltersSchema.optional(),
        active: z.boolean().optional(),
        agentName: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ action, subscriptionId, agentName, ...rest }) =>
      runTool(() => {
        const auth = agentAuth(agentName);
        switch (action) {
          case 'list':
            return listSubscriptionsHandler(auth);
          case 'create':
            return createSubscriptionHandler(auth, rest);
          case 'update':
            return updateSubscriptionHandler(auth, subscriptionId, rest);
          case 'delete':
            return deleteSubscriptionHandler(auth, subscriptionId);
        }
      }),
  );

  return server;
}
