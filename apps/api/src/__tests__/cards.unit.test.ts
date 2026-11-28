import { describe, expect, it } from 'vitest';
import { CardSchema, type Card } from '@agent-kanban/shared';
import { compareTodoCards, extractTrelloShortLink, nextMonotonicIso } from '../handlers/cards.js';
import { computeFieldDiff } from '../services/activity.js';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  buildIdempotencyDocId,
  normalizeIdempotencyKey,
} from '../services/idempotency.js';

function makeCard(overrides: Partial<Card> & { id: string }): Card {
  return CardSchema.parse({
    title: 'Sample task',
    description: '',
    status: 'todo',
    tags: [],
    assignedUserIds: ['user-alex'],
    awareUserIds: [],
    visibleToUserIds: ['user-alex'],
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
    searchTokens: ['sample', 'task'],
    trelloUrl: null,
    trelloShortLink: null,
    dueSoonNotifiedAt: null,
    overdueNotifiedAt: null,
    ...overrides,
  });
}

describe('Card handler & service unit tests', () => {
  it('sorts todo cards pinned first, then priorityScore DESC (nulls last), due ASC (nulls last), then createdAt ASC', () => {
    const cards = [
      makeCard({
        id: 'c-unscored-late',
        priorityScore: null,
        due: '2026-05-05T12:00:00.000Z',
        createdAt: '2026-05-01T09:00:00.000Z',
      }),
      makeCard({
        id: 'c-unscored-nodue-early',
        priorityScore: null,
        due: null,
        createdAt: '2026-05-01T08:00:00.000Z',
      }),
      makeCard({
        id: 'c-unscored-early',
        priorityScore: null,
        due: '2026-05-03T12:00:00.000Z',
        createdAt: '2026-05-01T10:00:00.000Z',
      }),
      makeCard({
        id: 'c-score-80-b',
        priorityScore: 80,
        due: '2026-05-04T12:00:00.000Z',
        createdAt: '2026-05-01T11:00:00.000Z',
      }),
      makeCard({
        id: 'c-score-80-a',
        priorityScore: 80,
        due: '2026-05-04T12:00:00.000Z',
        createdAt: '2026-05-01T09:00:00.000Z',
      }),
      makeCard({
        id: 'c-score-95',
        priorityScore: 95,
        due: null,
        createdAt: '2026-05-02T09:00:00.000Z',
      }),
      makeCard({
        id: 'c-score-80-nodue',
        priorityScore: 80,
        due: null,
        createdAt: '2026-05-01T07:00:00.000Z',
      }),
      makeCard({
        id: 'c-pinned-score-10',
        pinned: true,
        priorityScore: 10,
        due: '2026-05-06T12:00:00.000Z',
        createdAt: '2026-05-02T09:00:00.000Z',
      }),
      makeCard({
        id: 'c-pinned-unscored',
        pinned: true,
        priorityScore: null,
        due: null,
        createdAt: '2026-05-02T10:00:00.000Z',
      }),
      makeCard({
        id: 'c-score-100',
        pinned: false,
        priorityScore: 100,
        due: null,
        createdAt: '2026-05-01T06:00:00.000Z',
      }),
    ];

    const sortedIds = [...cards].sort(compareTodoCards).map((c) => c.id);
    expect(sortedIds).toEqual([
      'c-pinned-score-10',
      'c-pinned-unscored',
      'c-score-100',
      'c-score-95',
      'c-score-80-a',
      'c-score-80-b',
      'c-score-80-nodue',
      'c-unscored-early',
      'c-unscored-late',
      'c-unscored-nodue-early',
    ]);
  });

  it('computes field diffs using deep structural equality', () => {
    const before = {
      title: 'Fix porch light',
      tags: ['home', 'electrical'],
      priorityScore: 50,
      recurrence: { type: 'interval_after_completion', every: 30, unit: 'days' },
      due: null,
    };
    const after = {
      title: 'Fix porch light',
      tags: ['home', 'outdoor'],
      priorityScore: 75,
      recurrence: { type: 'interval_after_completion', every: 30, unit: 'days' },
      due: '2026-05-10T23:59:59.000Z',
    };

    const diff = computeFieldDiff(before, after, [
      'title',
      'tags',
      'priorityScore',
      'recurrence',
      'due',
    ]);

    expect(diff).toEqual({
      tags: { from: ['home', 'electrical'], to: ['home', 'outdoor'] },
      priorityScore: { from: 50, to: 75 },
      due: { from: null, to: '2026-05-10T23:59:59.000Z' },
    });
  });

  it('extracts Trello shortLink from standard card URLs and ignores non-Trello URLs', () => {
    expect(extractTrelloShortLink('https://trello.com/c/AbCd1234/my-task-slug')).toBe('AbCd1234');
    expect(extractTrelloShortLink('https://www.trello.com/c/xYz987')).toBe('xYz987');
    expect(extractTrelloShortLink('https://example.com/c/NotTrello')).toBeNull();
    expect(extractTrelloShortLink(null)).toBeNull();
  });

  it('guarantees monotonic updatedAt timestamps across same-millisecond writes', () => {
    const prev = '2026-05-01T12:00:00.500Z';
    expect(nextMonotonicIso(prev, new Date('2026-05-01T12:00:00.500Z'))).toBe(
      '2026-05-01T12:00:00.501Z',
    );
    expect(nextMonotonicIso(prev, new Date('2026-05-01T12:00:00.400Z'))).toBe(
      '2026-05-01T12:00:00.501Z',
    );
    expect(nextMonotonicIso(prev, new Date('2026-05-01T12:00:01.000Z'))).toBe(
      '2026-05-01T12:00:01.000Z',
    );
  });

  it('normalizes Idempotency-Key headers and scopes document IDs per ownerUserId', () => {
    expect(normalizeIdempotencyKey(undefined)).toBeUndefined();
    expect(normalizeIdempotencyKey('  req-key-123  ')).toBe('req-key-123');
    expect(() => normalizeIdempotencyKey('   ')).toThrow(/cannot be empty/);
    expect(() => normalizeIdempotencyKey('k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))).toThrow(
      /exceeds/,
    );

    const alexDocId = buildIdempotencyDocId('cards.create', 'user-alex', 'same-key');
    const samDocId = buildIdempotencyDocId('cards.create', 'user-sam', 'same-key');
    expect(alexDocId).toMatch(/^cards\.create_[a-f0-9]{64}$/);
    expect(samDocId).toMatch(/^cards\.create_[a-f0-9]{64}$/);
    expect(alexDocId).not.toBe(samDocId);
  });
});
