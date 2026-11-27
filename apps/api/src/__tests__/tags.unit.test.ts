import { describe, expect, it } from 'vitest';
import { CardSchema, type Card } from '@agent-kanban/shared';
import { aggregateTagSummaries, rewriteTags } from '../handlers/tags.js';

function makeCard(overrides: Partial<Card> & { id: string; tags: string[] }): Card {
  return CardSchema.parse({
    title: 'Sample task',
    description: '',
    status: 'todo',
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
    enteredStatusAt: '2026-06-01T12:00:00.000Z',
    lastTouchedAt: '2026-06-01T12:00:00.000Z',
    createdBy: 'user-alex',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
    searchTokens: ['sample', 'task'],
    trelloUrl: null,
    trelloShortLink: null,
    dueSoonNotifiedAt: null,
    overdueNotifiedAt: null,
    ...overrides,
  });
}

describe('Tag rewrite & vocabulary aggregation', () => {
  it('renames, merges, and removes tags case-insensitively without rewriting unrelated tags', () => {
    expect(rewriteTags(['Home', 'Groceries', 'home', 'Shopping'], 'GROCERIES', 'shopping')).toEqual(
      ['Home', 'shopping', 'home'],
    );
    expect(rewriteTags(['Groceries', 'GROCERIES', 'Errands'], 'groceries', null)).toEqual([
      'Errands',
    ]);
    expect(rewriteTags(['Home', 'Groceries', 'GROCERIES'], 'Groceries', 'groceries')).toEqual([
      'Home',
      'groceries',
    ]);
    expect(rewriteTags(['Home', 'home'], 'groceries', 'shopping')).toEqual(['Home', 'home']);
    expect(rewriteTags(['shopping', 'Groceries'], 'groceries', 'shopping')).toEqual(['shopping']);
  });

  it('sorts vocabulary by open count, total count, then tag and counts each card once', () => {
    const summaries = aggregateTagSummaries([
      makeCard({
        id: 'open-a',
        tags: ['Groceries', 'groceries', 'zeta'],
        updatedAt: '2026-06-01T12:00:00.000Z',
      }),
      makeCard({
        id: 'open-b',
        tags: ['Zeta'],
        status: 'doing',
        updatedAt: '2026-06-02T12:00:00.000Z',
      }),
      makeCard({
        id: 'done-groceries',
        tags: ['groceries'],
        status: 'done',
        updatedAt: '2026-06-03T12:00:00.000Z',
      }),
      makeCard({
        id: 'archived-groceries',
        tags: ['GROCERIES'],
        archived: true,
        updatedAt: '2026-06-04T12:00:00.000Z',
      }),
      makeCard({
        id: 'alpha-only',
        tags: ['alpha'],
        status: 'blocked',
        updatedAt: '2026-05-01T12:00:00.000Z',
      }),
    ]);

    expect(summaries.map((summary) => summary.tag)).toEqual(['zeta', 'groceries', 'alpha']);
    expect(summaries.find((summary) => summary.tag === 'zeta')).toEqual({
      tag: 'zeta',
      openCount: 2,
      totalCount: 2,
      lastUsedAt: '2026-06-02T12:00:00.000Z',
    });
    expect(summaries.find((summary) => summary.tag === 'groceries')).toEqual({
      tag: 'groceries',
      openCount: 1,
      totalCount: 3,
      lastUsedAt: '2026-06-04T12:00:00.000Z',
    });
    expect(summaries.find((summary) => summary.tag === 'alpha')).toMatchObject({
      openCount: 1,
      totalCount: 1,
    });
  });
});
