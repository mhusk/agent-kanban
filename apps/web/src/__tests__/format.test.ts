import { describe, expect, it } from 'vitest';
import type { User } from '@agent-kanban/shared';
import { formatActivitySummary } from '../lib/format.js';

const USERS: User[] = [
  {
    id: 'user-alex',
    workosUserId: 'workos-alex',
    email: 'alex@example.test',
    displayName: 'Alex Rivera',
    handle: 'alex',
    role: 'admin',
    createdAt: '2026-05-01T12:00:00.000Z',
  },
  {
    id: 'user-sam',
    workosUserId: 'workos-sam',
    email: 'sam@example.test',
    displayName: 'Sam Rivera',
    handle: 'sam',
    role: 'member',
    createdAt: '2026-05-01T12:00:00.000Z',
  },
];

const USERS_BY_ID = new Map(USERS.map((u) => [u.id, u]));

describe('formatActivitySummary', () => {
  it('formats creation and status changes cleanly', () => {
    expect(formatActivitySummary({ action: 'card.created', diff: {} }, USERS_BY_ID)).toEqual({
      headline: 'created this card',
      details: [],
    });

    expect(
      formatActivitySummary(
        { action: 'card.status_changed', diff: { status: { from: 'todo', to: 'doing' } } },
        USERS_BY_ID,
      ),
    ).toEqual({
      headline: 'changed status from To-Do to Doing',
      details: [],
    });
  });

  it('formats field updates including tags, resolved user names, due date, and recurrence while hiding redundant visibleToUserIds', () => {
    const summary = formatActivitySummary(
      {
        action: 'card.updated',
        diff: {
          title: { from: 'Old title', to: 'New title' },
          description: { from: '', to: 'Added details' },
          tags: { from: ['home', 'errands'], to: ['home', 'yard'] },
          assignedUserIds: { from: ['user-alex'], to: ['user-alex', 'user-sam'] },
          awareUserIds: { from: [], to: ['user-sam'] },
          visibleToUserIds: { from: ['user-alex'], to: ['user-alex', 'user-sam'] },
          due: { from: null, to: '2026-12-01T00:00:00.000Z' },
          recurrence: {
            from: null,
            to: { type: 'interval_after_completion', every: 7, unit: 'days' },
          },
        },
      },
      USERS_BY_ID,
    );

    expect(summary.headline).toBe('updated this card');
    expect(summary.details).toEqual([
      'Title: "Old title" → "New title"',
      'Added description',
      'Tags: added #yard; removed #errands',
      'Assigned: Alex Rivera → Alex Rivera, Sam Rivera',
      'Shared with: None → Sam Rivera',
      'Due date: None → Dec 1, 2026',
      'Recurrence: None → Every 7 days',
    ]);
  });

  it('formats checklists, links, comments, attachments, and completion resets', () => {
    expect(
      formatActivitySummary(
        {
          action: 'card.checklist_created',
          diff: { checklist: { from: null, to: { title: 'Gear' } } },
        },
        USERS_BY_ID,
      ).headline,
    ).toBe('added checklist "Gear"');

    expect(
      formatActivitySummary(
        {
          action: 'card.checklist_item_updated',
          diff: {
            checklistItem: {
              from: { text: 'Pack water', checked: false },
              to: { text: 'Pack water', checked: true },
            },
          },
        },
        USERS_BY_ID,
      ).headline,
    ).toBe('checked "Pack water"');

    expect(
      formatActivitySummary(
        {
          action: 'card.link_added',
          diff: { link: { from: null, to: { url: 'https://example.test', label: 'Trail map' } } },
        },
        USERS_BY_ID,
      ).headline,
    ).toBe('added link "Trail map"');

    expect(
      formatActivitySummary(
        {
          action: 'card.commented',
          diff: { comment: { from: null, to: { text: 'Hey @sam bring water' } } },
        },
        USERS_BY_ID,
      ),
    ).toEqual({
      headline: 'commented',
      details: ['"Hey @sam bring water"'],
    });

    expect(
      formatActivitySummary(
        {
          action: 'card.attachment_added',
          diff: { attachment: { from: null, to: { fileName: 'receipt.pdf' } } },
        },
        USERS_BY_ID,
      ).headline,
    ).toBe('attached "receipt.pdf"');

    expect(
      formatActivitySummary(
        {
          action: 'card.completed',
          diff: {
            status: { from: 'doing', to: 'todo' },
            due: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-08T00:00:00.000Z' },
          },
        },
        USERS_BY_ID,
      ),
    ).toEqual({
      headline: 'completed & reset this card',
      details: ['Next due: Dec 8, 2026', 'Status: Doing → To-Do'],
    });
  });
});
