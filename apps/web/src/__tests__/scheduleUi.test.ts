import { describe, expect, it } from 'vitest';
import { CardSchema, type Card } from '@agent-kanban/shared';
import {
  bucketForDayOffset,
  buildUpcomingTimeline,
  calendarDayKey,
  countSnoozedCards,
  formatScheduleCadence,
  formatSnoozeChips,
  groupUpcomingTimeline,
} from '../lib/scheduleUi.js';

const NY = 'America/New_York';

function card(partial: Partial<Card> & Pick<Card, 'id' | 'title'>): Card {
  return CardSchema.parse({
    status: 'todo',
    visibleToUserIds: ['user-alex'],
    priorityScore: null,
    priorityReason: null,
    due: null,
    recurrence: null,
    enteredStatusAt: '2026-05-01T12:00:00.000Z',
    lastTouchedAt: '2026-05-01T12:00:00.000Z',
    createdBy: 'user-alex',
    createdAt: '2026-05-01T12:00:00.000Z',
    updatedAt: '2026-05-01T12:00:00.000Z',
    ...partial,
  });
}

describe('schedule timezone buckets', () => {
  it('keeps date-only dues on their calendar day across a timezone boundary', () => {
    const now = new Date('2026-06-01T03:30:00.000Z');
    expect(calendarDayKey(now.toISOString(), NY, false)).toBe('2026-05-31');
    expect(calendarDayKey(now.toISOString(), 'UTC', false)).toBe('2026-06-01');
    expect(calendarDayKey('2026-06-01T00:00:00.000Z', NY, true)).toBe('2026-06-01');

    const items = buildUpcomingTimeline(
      {
        timezone: NY,
        recurring: [
          {
            card: card({
              id: 'card-date-only',
              title: 'Date only chore',
              due: '2026-06-01T00:00:00.000Z',
              dueHasTime: false,
              recurrence: { type: 'cron', expression: '0 9 * * 1' },
            }),
            nextOccurrences: ['2026-06-01T00:00:00.000Z'],
            cadence: 'weekly',
            effectiveLeadDays: 1,
          },
        ],
        deferredCards: [],
      },
      now,
    );

    expect(items.find((item) => item.kind === 'active')?.bucket).toBe('next7');
    expect(items.some((item) => item.kind === 'occurrence')).toBe(false);
  });

  it('places a snoozed card on its wake day and labels Monday in three days', () => {
    const now = new Date('2026-05-29T16:00:00.000Z');
    const deferUntil = '2026-06-01T04:00:00.000Z';
    expect(formatSnoozeChips(deferUntil, NY, now)).toEqual({
      wakesLabel: 'Wakes in 3d',
      snoozedLabel: 'Snoozed until Mon',
    });

    const snoozed = card({
      id: 'card-snoozed',
      title: 'Snoozed linen change',
      due: '2026-07-01T00:00:00.000Z',
      deferUntil,
      recurrence: { type: 'interval_after_completion', every: 30, unit: 'days' },
    });
    const groups = groupUpcomingTimeline(
      buildUpcomingTimeline(
        {
          timezone: NY,
          recurring: [
            {
              card: snoozed,
              nextOccurrences: ['2026-07-01T00:00:00.000Z'],
              cadence: 'every 30 days',
              effectiveLeadDays: 3,
            },
          ],
          deferredCards: [
            card({
              id: 'card-plain',
              title: 'Plain snooze',
              deferUntil: '2026-06-20T04:00:00.000Z',
            }),
          ],
        },
        now,
      ),
    );

    const snoozedRow = groups
      .flatMap((group) => group.items)
      .find((item) => item.card.id === 'card-snoozed' && item.kind === 'snoozed');
    expect(snoozedRow?.bucket).toBe('next7');
    expect(snoozedRow?.wakesLabel).toBe('Wakes in 3d');
    expect(groups.some((group) => group.items.some((item) => item.kind === 'active'))).toBe(false);
    expect(
      groups
        .find((group) => group.id === 'later')
        ?.items.some((item) => item.card.id === 'card-snoozed' && item.kind === 'occurrence'),
    ).toBe(true);
    expect(countSnoozedCards({ recurring: [{ card: snoozed }], deferredCards: [] }, now)).toBe(1);
  });

  it('describes standard cron and interval cadence in editor sentences', () => {
    expect(formatScheduleCadence({ type: 'cron', expression: '0 5 * * 0' })).toBe(
      'Every Sunday at 5:00 AM',
    );
    expect(
      formatScheduleCadence({ type: 'interval_after_completion', every: 30, unit: 'days' }),
    ).toBe('Every 30 days after completion');
    expect(formatScheduleCadence(null)).toBeNull();
  });

  it('maps day offsets onto the four timeline windows', () => {
    expect(bucketForDayOffset(0)).toBe('now');
    expect(bucketForDayOffset(-2)).toBe('now');
    expect(bucketForDayOffset(7)).toBe('next7');
    expect(bucketForDayOffset(8)).toBe('next30');
    expect(bucketForDayOffset(30)).toBe('next30');
    expect(bucketForDayOffset(31)).toBe('later');
  });
});
