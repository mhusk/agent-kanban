import { describe, expect, it } from 'vitest';
import { CardSchema, type Card } from '@agent-kanban/shared';
import { buildBulkEventRecords, buildEventRecord } from '../services/events.js';

const SAMPLE_CARD = CardSchema.parse({
  id: 'card-1',
  title: 'Test card',
  description: '',
  status: 'todo',
  tags: ['home'],
  assignedUserIds: ['user-alex'],
  awareUserIds: ['user-sam'],
  visibleToUserIds: ['user-alex', 'user-sam'],
  priorityScore: null,
  priorityReason: null,
  due: null,
  dueFirm: false,
  dueHasTime: false,
  recurrence: null,
  links: [],
  checklists: [],
  archived: false,
  enteredStatusAt: '2026-05-01T12:00:00.000Z',
  lastTouchedAt: '2026-05-01T12:00:00.000Z',
  createdBy: 'user-alex',
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z',
  searchTokens: ['test', 'card'],
  trelloUrl: null,
  trelloShortLink: null,
  dueSoonNotifiedAt: null,
  overdueNotifiedAt: null,
});

describe('buildEventRecord agent loop suppression', () => {
  it('returns null when actorType is agent', () => {
    const result = buildEventRecord({
      type: 'card.created',
      card: SAMPLE_CARD,
      auth: {
        actorType: 'agent',
        userId: 'user-alex',
        agentName: 'Chief of Staff',
        platform: 'Automation Bot',
      },
      note: 'Agent write must not emit events',
    });
    expect(result).toBeNull();
  });

  it('builds a valid Event for human and system actors', () => {
    const humanEvent = buildEventRecord({
      type: 'card.created',
      card: SAMPLE_CARD,
      auth: {
        actorType: 'human',
        userId: 'user-alex',
      },
      note: 'Human write',
    });
    expect(humanEvent).not.toBeNull();
    expect(humanEvent?.type).toBe('card.created');
    expect(humanEvent?.visibleToUserIds).toEqual(['user-alex', 'user-sam']);
    expect(humanEvent?.actor.actorType).toBe('human');
    expect(humanEvent?.note).toBe('Human write');

    const systemEvent = buildEventRecord({
      type: 'card.due_soon',
      card: SAMPLE_CARD,
      auth: {
        actorType: 'system',
        userId: 'system',
      },
    });
    expect(systemEvent).not.toBeNull();
    expect(systemEvent?.type).toBe('card.due_soon');
    expect(systemEvent?.actor.actorType).toBe('system');
  });
});

describe('buildBulkEventRecords visibility grouping', () => {
  const human = {
    actorType: 'human' as const,
    userId: 'user-alex',
  };

  function cardWith(id: string, visibleToUserIds: string[], tags: string[] = ['home']): Card {
    return CardSchema.parse({
      ...SAMPLE_CARD,
      id,
      tags,
      assignedUserIds: visibleToUserIds.slice(0, 1),
      awareUserIds: visibleToUserIds.slice(1),
      visibleToUserIds,
      status: id.endsWith('doing') ? 'doing' : 'todo',
    });
  }

  it('emits one event per canonical visibility group and hides private card ids', () => {
    const sharedA = cardWith('card-shared-a', ['user-sam', 'user-alex'], ['Groceries']);
    const sharedB = cardWith('card-shared-b', ['user-alex', 'user-sam'], ['Home']);
    const privateAlex = cardWith('card-private-alex', ['user-alex'], ['Private']);
    const privateSam = cardWith('card-private-sam-doing', ['user-sam'], ['Finance']);

    const events = buildBulkEventRecords({
      cards: [sharedA, privateAlex, sharedB, privateSam],
      auth: human,
      actionSummary: 'updated',
      rescoreRequestedCardIds: ['card-private-alex'],
      note: 'Bulk triage',
    });

    expect(events).toHaveLength(3);
    const byKey = new Map(events.map((event) => [event.visibleToUserIds.join(','), event]));

    const shared = byKey.get('user-alex,user-sam');
    expect(shared?.type).toBe('cards.bulk_updated');
    expect(shared?.cardId).toBeNull();
    expect(shared?.payload.cardIds).toEqual(['card-shared-a', 'card-shared-b']);
    expect(shared?.payload.count).toBe(2);
    expect(shared?.payload.tags).toEqual(['groceries', 'home']);
    expect(shared?.payload.statuses).toEqual(['todo']);
    expect(shared?.payload.actionSummary).toBe('updated');
    expect(shared?.payload.rescoreRequested).toBe(false);
    expect(JSON.stringify(shared?.payload)).not.toContain('card-private');

    const alexOnly = byKey.get('user-alex');
    expect(alexOnly?.cardId).toBe('card-private-alex');
    expect(alexOnly?.payload.cardIds).toEqual(['card-private-alex']);
    expect(alexOnly?.payload.rescoreRequested).toBe(true);
    expect(alexOnly?.visibleToUserIds).toEqual(['user-alex']);

    const samOnly = byKey.get('user-sam');
    expect(samOnly?.cardId).toBe('card-private-sam-doing');
    expect(samOnly?.payload.statuses).toEqual(['doing']);
    expect(samOnly?.visibleToUserIds).not.toContain('user-alex');
    expect(JSON.stringify(samOnly?.payload)).not.toContain('card-private-alex');
  });

  it('returns no events for agent actors', () => {
    const events = buildBulkEventRecords({
      cards: [SAMPLE_CARD],
      auth: {
        actorType: 'agent',
        userId: 'user-alex',
        agentName: 'Chief of Staff',
        platform: 'Automation Bot',
      },
      actionSummary: 'updated',
    });
    expect(events).toEqual([]);
  });
});
