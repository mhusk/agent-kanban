import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  ActivitySchema,
  ActorTypeSchema,
  AgentConnectionSchema,
  ArchiveCardInputSchema,
  AttachmentSchema,
  BulkCardUpdateSchema,
  BulkPriorityUpdateSchema,
  CardSchema,
  CardStatusSchema,
  ChangeCardStatusInputSchema,
  ChecklistItemSchema,
  ChecklistSchema,
  CommentSchema,
  CreateAgentConnectionSchema,
  CreateCardInputSchema,
  CreateCommentInputSchema,
  CreateSubscriptionEmulatorSchema,
  CreateSubscriptionSchema,
  CreateUserInputSchema,
  EventSchema,
  EventTypeSchema,
  LinkAttachmentSchema,
  MAX_ATTACHMENT_SIZE_BYTES,
  RecurrenceSchema,
  SubscriptionEmulatorSchema,
  SubscriptionSchema,
  UpdateAgentConnectionSchema,
  UpdateCardInputSchema,
  UpdateSubscriptionSchema,
  UploadUrlRequestSchema,
  UserSchema,
} from '../index.js';

const NOW = '2026-05-01T14:30:00.000Z';

describe('User schemas', () => {
  it('accepts valid users and normalizes email/handle on create input', () => {
    const user = UserSchema.parse({
      id: 'user_alex',
      workosUserId: 'workos_01',
      email: 'Alex@example.test',
      displayName: 'Alex Rivera',
      handle: 'alex',
      role: 'admin',
      createdAt: NOW,
    });
    expect(user.email).toBe('alex@example.test');
    expect(user.role).toBe('admin');

    const input = CreateUserInputSchema.parse({
      email: '  Sam@Example.Test ',
      displayName: 'Sam Rivera',
      handle: '@Sam_R',
    });
    expect(input).toEqual({
      email: 'sam@example.test',
      displayName: 'Sam Rivera',
      handle: 'sam_r',
      role: 'member',
    });
  });

  it('rejects invalid email, handle, and role', () => {
    expect(
      CreateUserInputSchema.safeParse({
        email: 'not-an-email',
        displayName: 'Alex Rivera',
        handle: 'alex',
      }).success,
    ).toBe(false);

    expect(
      CreateUserInputSchema.safeParse({
        email: 'alex@example.test',
        displayName: 'Alex Rivera',
        handle: 'bad handle!',
      }).success,
    ).toBe(false);

    expect(
      UserSchema.safeParse({
        id: 'user_alex',
        workosUserId: null,
        email: 'alex@example.test',
        displayName: 'Alex Rivera',
        handle: 'alex',
        role: 'owner',
        createdAt: NOW,
      }).success,
    ).toBe(false);
  });
});

describe('Card, Checklist, Link, Recurrence & Bulk schemas', () => {
  const validCard = {
    id: 'card_01',
    title: 'Replace HVAC air filter',
    description: 'Order MERV-11 20x25x1 filter and swap in hallway return.',
    status: 'todo' as const,
    tags: ['home', 'maintenance'],
    assignedUserIds: ['user_alex'],
    awareUserIds: ['user_sam'],
    visibleToUserIds: ['user_alex', 'user_sam'],
    priorityScore: 72,
    priorityReason: 'Filter is due for quarterly replacement this week.',
    due: '2026-05-09T23:59:59.000Z',
    dueFirm: false,
    dueHasTime: false,
    recurrence: {
      type: 'interval_after_completion' as const,
      every: 90,
      unit: 'days' as const,
      timezone: 'America/New_York',
    },
    links: [
      {
        id: 'link_01',
        url: 'https://example.test/filters',
        label: 'Filter specs',
        createdAt: NOW,
      },
    ],
    checklists: [
      {
        id: 'chk_01',
        title: 'Steps',
        items: [
          { id: 'item_01', text: 'Turn off blower', checked: true },
          { id: 'item_02', text: 'Install new filter', checked: false },
        ],
      },
    ],
    archived: false,
    enteredStatusAt: NOW,
    lastTouchedAt: NOW,
    createdBy: 'user_alex',
    createdAt: NOW,
    updatedAt: NOW,
    searchTokens: ['replace', 'hvac', 'air', 'filter'],
    trelloUrl: 'https://trello.com/c/AbCd1234/legacy-card',
    trelloShortLink: 'AbCd1234',
    dueSoonNotifiedAt: null,
    overdueNotifiedAt: null,
  };

  it('accepts valid card, statuses, checklists, links, and recurrences', () => {
    expect(CardSchema.parse(validCard).title).toBe('Replace HVAC air filter');

    for (const status of ['todo', 'doing', 'blocked', 'done']) {
      expect(CardStatusSchema.parse(status)).toBe(status);
    }

    expect(ChecklistItemSchema.parse({ id: 'i1', text: 'Milk' }).checked).toBe(false);
    expect(ChecklistSchema.parse({ id: 'c1', title: 'Groceries' }).items).toEqual([]);
    expect(LinkAttachmentSchema.parse({ id: 'l1', url: 'https://example.test' }).url).toBe(
      'https://example.test',
    );

    expect(
      RecurrenceSchema.parse({
        type: 'cron',
        expression: '0 7 * * 6',
        timezone: 'America/New_York',
      }),
    ).toEqual({
      type: 'cron',
      expression: '0 7 * * 6',
      timezone: 'America/New_York',
    });

    for (const unit of ['days', 'weeks', 'months'] as const) {
      const parsed = RecurrenceSchema.parse({
        type: 'interval_after_completion',
        every: 2,
        unit,
        timezone: 'UTC',
      });
      expect(parsed).toEqual({
        type: 'interval_after_completion',
        every: 2,
        unit,
        timezone: 'UTC',
      });
    }
  });

  it('applies defaults on CreateCardInputSchema and validates UpdateCardInputSchema', () => {
    const created = CreateCardInputSchema.parse({
      title: '  Book dental cleaning  ',
      note: 'Created from weekly review',
    });
    expect(created.title).toBe('Book dental cleaning');
    expect(created.status).toBe('todo');
    expect(created.priorityScore).toBeNull();
    expect(created.due).toBeNull();
    expect(created.dueFirm).toBe(false);
    expect(created.dueHasTime).toBe(false);
    expect(created.recurrence).toBeNull();

    const updated = UpdateCardInputSchema.parse({
      priorityScore: 0,
      ifUpdatedAt: NOW,
      note: 'Deprioritized after call',
    });
    expect(updated.priorityScore).toBe(0);
    expect(UpdateCardInputSchema.parse({ priorityScore: 100 }).priorityScore).toBe(100);
    expect(UpdateCardInputSchema.parse({ priorityScore: null }).priorityScore).toBeNull();

    const statusChange = ChangeCardStatusInputSchema.parse({
      status: 'doing',
      ifUpdatedAt: NOW,
      note: 'Picking this up now',
    });
    expect(statusChange).toEqual({
      status: 'doing',
      ifUpdatedAt: NOW,
      note: 'Picking this up now',
    });
    expect(ChangeCardStatusInputSchema.safeParse({ status: 'paused' }).success).toBe(false);

    expect(ArchiveCardInputSchema.parse({})).toEqual({ archived: true });
    expect(
      ArchiveCardInputSchema.parse({
        archived: false,
        ifUpdatedAt: NOW,
        note: 'Restoring card',
      }),
    ).toEqual({
      archived: false,
      ifUpdatedAt: NOW,
      note: 'Restoring card',
    });
  });

  it('rejects empty card title, out-of-range priorityScore, and invalid recurrence', () => {
    expect(CreateCardInputSchema.safeParse({ title: '' }).success).toBe(false);
    expect(CreateCardInputSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(CardSchema.safeParse({ ...validCard, title: '' }).success).toBe(false);

    expect(CardSchema.safeParse({ ...validCard, priorityScore: -1 }).success).toBe(false);
    expect(CardSchema.safeParse({ ...validCard, priorityScore: 101 }).success).toBe(false);
    expect(UpdateCardInputSchema.safeParse({ priorityScore: -0.1 }).success).toBe(false);
    expect(UpdateCardInputSchema.safeParse({ priorityScore: 100.5 }).success).toBe(false);

    expect(
      RecurrenceSchema.safeParse({
        type: 'interval_after_completion',
        every: 1,
        unit: 'hours',
      }).success,
    ).toBe(false);

    expect(
      RecurrenceSchema.safeParse({
        type: 'interval_after_completion',
        every: 0,
        unit: 'days',
      }).success,
    ).toBe(false);

    expect(
      RecurrenceSchema.safeParse({
        type: 'cron',
        expression: '0 7 * *', // only 4 fields
      }).success,
    ).toBe(false);

    expect(
      RecurrenceSchema.safeParse({
        type: 'cron',
        expression: '0 0 7 * * 6', // 6 fields
      }).success,
    ).toBe(false);

    expect(
      RecurrenceSchema.safeParse({
        type: 'cron',
        expression: '0 7 * * 6',
        timezone: 'Mars/Olympus',
      }).success,
    ).toBe(false);

    expect(
      LinkAttachmentSchema.safeParse({
        id: 'l1',
        url: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
  });

  it('validates bulk priority and bulk card updates', () => {
    const bulkPriority = BulkPriorityUpdateSchema.parse({
      updates: [
        { cardId: 'card_01', priorityScore: 95, priorityReason: 'Due tomorrow' },
        { cardId: 'card_02', priorityScore: null, priorityReason: null },
      ],
      note: 'Morning reprioritization pass',
    });
    expect(bulkPriority.updates).toHaveLength(2);

    expect(BulkPriorityUpdateSchema.safeParse({ updates: [] }).success).toBe(false);
    expect(
      BulkPriorityUpdateSchema.safeParse({
        updates: [{ cardId: 'card_01', priorityScore: 150 }],
      }).success,
    ).toBe(false);

    const bulkCard = BulkCardUpdateSchema.parse({
      updates: [
        {
          cardId: 'card_01',
          status: 'doing',
          addTags: ['urgent'],
          removeTags: ['someday'],
        },
      ],
    });
    expect(bulkCard.updates).toHaveLength(1);
    expect(BulkCardUpdateSchema.safeParse({ updates: [] }).success).toBe(false);
  });
});

describe('Comment & Activity schemas', () => {
  it('accepts valid comments and activity entries', () => {
    const comment = CommentSchema.parse({
      id: 'cmt_01',
      cardId: 'card_01',
      actorType: 'agent',
      actorId: 'user_alex',
      agentName: 'Chief of Staff',
      platform: 'Automation Bot',
      text: 'Flagged for @sam ahead of Saturday.',
      mentions: ['user_sam'],
      createdAt: NOW,
    });
    expect(comment.mentions).toEqual(['user_sam']);

    expect(CreateCommentInputSchema.parse({ text: 'On it!' }).text).toBe('On it!');
    expect(CreateCommentInputSchema.safeParse({ text: '   ' }).success).toBe(false);

    for (const actorType of ['human', 'agent', 'system']) {
      expect(ActorTypeSchema.parse(actorType)).toBe(actorType);
    }

    const activity = ActivitySchema.parse({
      id: 'act_01',
      cardId: 'card_01',
      visibleToUserIds: ['user_alex', 'user_sam'],
      actorType: 'human',
      actorId: 'user_alex',
      action: 'card.status_changed',
      diff: { status: { from: 'todo', to: 'doing' } },
      note: 'Starting now',
      createdAt: NOW,
    });
    expect(activity.agentName).toBeNull();
    expect(activity.diff.status).toEqual({ from: 'todo', to: 'doing' });
  });

  it('rejects unknown actorType or empty visibleToUserIds', () => {
    expect(ActorTypeSchema.safeParse('bot').success).toBe(false);
    expect(
      ActivitySchema.safeParse({
        id: 'act_01',
        cardId: 'card_01',
        visibleToUserIds: [],
        actorType: 'human',
        actorId: 'user_alex',
        action: 'card.created',
        createdAt: NOW,
      }).success,
    ).toBe(false);
  });
});

describe('Attachment schemas', () => {
  it('accepts all allowlisted MIME types up to exact 10 MB limit', () => {
    for (const contentType of ALLOWED_ATTACHMENT_MIME_TYPES) {
      const req = UploadUrlRequestSchema.parse({
        fileName: 'receipt.dat',
        contentType,
        size: MAX_ATTACHMENT_SIZE_BYTES,
      });
      expect(req.size).toBe(10 * 1024 * 1024);
    }

    const attachment = AttachmentSchema.parse({
      id: 'att_01',
      cardId: 'card_01',
      storagePath: 'cards/card_01/att_01/invoice.pdf',
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
      size: 204800,
      uploadedBy: 'user_alex',
      createdAt: NOW,
    });
    expect(attachment.contentType).toBe('application/pdf');
  });

  it('rejects oversized attachments, zero-byte files, and disallowed MIME types', () => {
    expect(
      UploadUrlRequestSchema.safeParse({
        fileName: 'huge.jpg',
        contentType: 'image/jpeg',
        size: MAX_ATTACHMENT_SIZE_BYTES + 1,
      }).success,
    ).toBe(false);

    expect(
      UploadUrlRequestSchema.safeParse({
        fileName: 'empty.png',
        contentType: 'image/png',
        size: 0,
      }).success,
    ).toBe(false);

    for (const badMime of ['text/html', 'application/javascript', 'image/svg+xml', 'text/plain']) {
      expect(
        UploadUrlRequestSchema.safeParse({
          fileName: 'file.bin',
          contentType: badMime,
          size: 1024,
        }).success,
      ).toBe(false);
    }
  });
});

describe('Agent connection, Subscription & Event schemas', () => {
  it('validates agent connections, strict HTTPS subscriptions, and events', () => {
    const connection = AgentConnectionSchema.parse({
      id: 'conn_01',
      ownerUserId: 'user_alex',
      platform: 'Automation Bot',
      authType: 'api_key',
      keyPrefix: 'ak_abcd1234',
      revoked: false,
      rotatedAt: null,
      createdAt: NOW,
    });
    expect(connection.platform).toBe('Automation Bot');
    expect(connection.defaultAgentName).toBeNull();

    const connectionWithAgent = AgentConnectionSchema.parse({
      id: 'conn_02',
      ownerUserId: 'user_alex',
      platform: 'Automation Bot',
      defaultAgentName: '  Chief of Staff  ',
      authType: 'api_key',
      keyPrefix: 'ak_abcd1234',
      revoked: false,
      rotatedAt: null,
      createdAt: NOW,
    });
    expect(connectionWithAgent.defaultAgentName).toBe('Chief of Staff');

    expect(CreateAgentConnectionSchema.parse({ platform: 'Chief of Staff' }).platform).toBe(
      'Chief of Staff',
    );
    expect(
      CreateAgentConnectionSchema.parse({
        platform: 'Automation Bot',
        defaultAgentName: '  Chief of Staff  ',
      }).defaultAgentName,
    ).toBe('Chief of Staff');
    expect(
      CreateAgentConnectionSchema.parse({
        platform: 'Automation Bot',
        defaultAgentName: '   ',
      }).defaultAgentName,
    ).toBeNull();
    expect(CreateAgentConnectionSchema.safeParse({ platform: '  ' }).success).toBe(false);

    expect(
      UpdateAgentConnectionSchema.parse({
        platform: 'Relay Bot',
        defaultAgentName: 'Chief of Staff',
      }),
    ).toEqual({
      platform: 'Relay Bot',
      defaultAgentName: 'Chief of Staff',
    });
    expect(UpdateAgentConnectionSchema.parse({ defaultAgentName: '' })).toEqual({
      defaultAgentName: null,
    });
    expect(UpdateAgentConnectionSchema.parse({ defaultAgentName: null })).toEqual({
      defaultAgentName: null,
    });
    expect(UpdateAgentConnectionSchema.safeParse({}).success).toBe(false);
    expect(UpdateAgentConnectionSchema.safeParse({ platform: '   ' }).success).toBe(false);

    const createSub = CreateSubscriptionSchema.parse({
      connectionId: 'conn_01',
      webhookUrl: 'https://hooks.example.test/agent-kanban',
      authType: 'hmac',
      secret: 'test-webhook-secret-123456',
      filters: {
        eventTypes: ['card.created', 'card.due_soon'],
        tags: ['groceries'],
        statuses: ['todo'],
      },
    });
    expect(createSub.active).toBe(true);

    const sub = SubscriptionSchema.parse({
      id: 'sub_01',
      ownerUserId: 'user_alex',
      connectionId: 'conn_01',
      webhookUrl: 'https://hooks.example.test/agent-kanban',
      authType: 'bearer',
      filters: {
        eventTypes: ['card.commented'],
        mentionedUserIds: ['user_sam'],
      },
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(sub.authType).toBe('bearer');

    const createStandardSub = CreateSubscriptionSchema.parse({
      webhookUrl: 'https://hooks.example.test/standard',
      authType: 'standard_webhooks',
      secret: 'whsec_test-standard-secret-123456',
      filters: {
        eventTypes: ['card.created'],
      },
    });
    expect(createStandardSub.authType).toBe('standard_webhooks');

    const standardSub = SubscriptionSchema.parse({
      id: 'sub_02',
      ownerUserId: 'user_alex',
      connectionId: null,
      webhookUrl: 'https://hooks.example.test/standard',
      authType: 'standard_webhooks',
      filters: {
        eventTypes: ['card.created'],
      },
      active: true,
      lastDelivery: {
        status: 'pending',
        attemptCount: 1,
        lastAttemptAt: NOW,
        nextAttemptAt: NOW,
        lastError: 'HTTP 400',
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(standardSub.authType).toBe('standard_webhooks');
    expect(standardSub.lastDelivery?.lastError).toBe('HTTP 400');

    const event = EventSchema.parse({
      id: 'evt_01',
      type: 'card.created',
      cardId: 'card_01',
      visibleToUserIds: ['user_alex', 'user_sam'],
      actor: {
        actorType: 'human',
        actorId: 'user_alex',
      },
      note: 'Added from mobile',
      payload: { status: 'todo', tags: ['groceries'] },
      createdAt: NOW,
    });
    expect(event.deliveries).toEqual({});
    expect(event.actor.agentName).toBeNull();

    for (const evtType of [
      'card.created',
      'card.updated',
      'card.status_changed',
      'card.commented',
      'card.completed',
      'card.due_soon',
      'card.overdue',
    ]) {
      expect(EventTypeSchema.parse(evtType)).toBe(evtType);
    }
  });

  it('rejects non-HTTPS webhook URLs in strict schemas and invalid subscription fields', () => {
    expect(
      CreateSubscriptionSchema.safeParse({
        webhookUrl: 'http://hooks.example.test/agent-kanban',
        authType: 'bearer',
        secret: 'test-webhook-secret-123456',
        filters: { eventTypes: ['card.created'] },
      }).success,
    ).toBe(false);

    expect(
      CreateSubscriptionSchema.safeParse({
        webhookUrl: 'http://127.0.0.1:4567/hook',
        authType: 'bearer',
        secret: 'test-webhook-secret-123456',
        filters: { eventTypes: ['card.created'] },
      }).success,
    ).toBe(false);

    expect(
      UpdateSubscriptionSchema.safeParse({
        webhookUrl: 'http://hooks.example.test/hook',
      }).success,
    ).toBe(false);

    expect(
      SubscriptionSchema.safeParse({
        id: 'sub_01',
        ownerUserId: 'user_alex',
        webhookUrl: 'http://hooks.example.test/hook',
        authType: 'hmac',
        filters: { eventTypes: ['card.created'] },
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(false);

    // Emulator schema permits localhost/127.0.0.1 HTTP, still rejects external HTTP
    expect(
      CreateSubscriptionEmulatorSchema.safeParse({
        webhookUrl: 'http://127.0.0.1:4567/hook',
        authType: 'hmac',
        secret: 'test-webhook-secret-123456',
        filters: { eventTypes: ['card.created'] },
      }).success,
    ).toBe(true);

    expect(
      SubscriptionEmulatorSchema.safeParse({
        id: 'sub_01',
        ownerUserId: 'user_alex',
        webhookUrl: 'http://localhost:4567/hook',
        authType: 'bearer',
        filters: { eventTypes: ['card.created'] },
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);

    expect(
      SubscriptionEmulatorSchema.safeParse({
        id: 'sub_01',
        ownerUserId: 'user_alex',
        webhookUrl: 'http://hooks.example.test/hook',
        authType: 'bearer',
        filters: { eventTypes: ['card.created'] },
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(false);

    expect(
      CreateSubscriptionEmulatorSchema.safeParse({
        webhookUrl: 'http://hooks.example.test/hook',
        authType: 'hmac',
        secret: 'test-webhook-secret-123456',
        filters: { eventTypes: ['card.created'] },
      }).success,
    ).toBe(false);

    // Empty eventTypes or too-short secret
    expect(
      CreateSubscriptionSchema.safeParse({
        webhookUrl: 'https://hooks.example.test/hook',
        authType: 'hmac',
        secret: 'short',
        filters: { eventTypes: ['card.created'] },
      }).success,
    ).toBe(false);

    expect(
      CreateSubscriptionSchema.safeParse({
        webhookUrl: 'https://hooks.example.test/hook',
        authType: 'hmac',
        secret: 'test-webhook-secret-123456',
        filters: { eventTypes: [] },
      }).success,
    ).toBe(false);
  });
});
