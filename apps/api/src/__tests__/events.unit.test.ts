import { describe, expect, it } from 'vitest';
import { CardSchema } from '@agent-kanban/shared';
import { buildEventRecord } from '../services/events.js';

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
