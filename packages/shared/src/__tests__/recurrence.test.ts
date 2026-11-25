import { describe, expect, it } from 'vitest';
import { computeNextDueDate } from '../index.js';

describe('computeNextDueDate recurrence engine', () => {
  const NY = 'America/New_York';

  it('computes Saturday 7:00 AM cron in America/New_York including exact-tick advance and DST transitions', () => {
    const saturdayCron = {
      type: 'cron' as const,
      expression: '0 7 * * 6',
      timezone: NY,
    };

    // Mid-week Wednesday 2026-03-04 15:00Z (10:00 EST) -> Saturday 2026-03-07 07:00 EST (12:00Z)
    expect(computeNextDueDate(saturdayCron, '2026-03-04T15:00:00.000Z', null)).toBe(
      '2026-03-07T12:00:00.000Z',
    );

    // Completed at exact cron tick Saturday 2026-03-07 07:00 EST (12:00Z) -> must advance strictly to next Saturday 2026-03-14 07:00 EDT (11:00Z, after spring-forward!)
    expect(computeNextDueDate(saturdayCron, '2026-03-07T12:00:00.000Z', null)).toBe(
      '2026-03-14T11:00:00.000Z',
    );

    // Crossing DST fall-back: Saturday 2026-10-31 07:00 EDT (11:00Z) -> Saturday 2026-11-07 07:00 EST (12:00Z)
    expect(computeNextDueDate(saturdayCron, '2026-10-31T11:00:00.000Z', null)).toBe(
      '2026-11-07T12:00:00.000Z',
    );
  });

  it('uses defaultTz when recurrence.timezone is omitted and lets recurrence.timezone override it', () => {
    const withoutTz = {
      type: 'cron' as const,
      expression: '0 7 * * 6',
    };
    expect(computeNextDueDate(withoutTz, '2026-03-04T15:00:00.000Z', null, NY)).toBe(
      '2026-03-07T12:00:00.000Z',
    );
    expect(computeNextDueDate(withoutTz, '2026-03-04T15:00:00.000Z', null, 'UTC')).toBe(
      '2026-03-07T07:00:00.000Z',
    );
  });

  it('computes interval_after_completion for 30 days using local calendar date in timezone', () => {
    const thirtyDays = {
      type: 'interval_after_completion' as const,
      every: 30,
      unit: 'days' as const,
    };

    // 2026-05-02T01:30:00.000Z is 2026-05-01 21:30 EDT in America/New_York -> +30 days = 2026-05-31
    expect(
      computeNextDueDate(thirtyDays, '2026-05-02T01:30:00.000Z', null, NY, { dueHasTime: false }),
    ).toBe('2026-05-31T00:00:00.000Z');
  });

  it('computes weeks and months intervals with month-end clamping', () => {
    const twoWeeks = {
      type: 'interval_after_completion' as const,
      every: 2,
      unit: 'weeks' as const,
    };
    expect(computeNextDueDate(twoWeeks, '2026-06-01T14:00:00.000Z', null, 'UTC')).toBe(
      '2026-06-15T00:00:00.000Z',
    );

    const oneMonth = {
      type: 'interval_after_completion' as const,
      every: 1,
      unit: 'months' as const,
    };
    // Non-leap year clamping: Jan 31 -> Feb 28
    expect(computeNextDueDate(oneMonth, '2026-01-31T15:00:00.000Z', null, NY)).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    // Leap year clamping: Jan 31 -> Feb 29
    expect(computeNextDueDate(oneMonth, '2028-01-31T15:00:00.000Z', null, NY)).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    // 31 -> 30 clamping: Mar 31 -> Apr 30
    expect(computeNextDueDate(oneMonth, '2026-03-31T15:00:00.000Z', null, NY)).toBe(
      '2026-04-30T00:00:00.000Z',
    );
  });

  it('preserves local wall-clock time across DST when dueHasTime is true', () => {
    const thirtyDays = {
      type: 'interval_after_completion' as const,
      every: 30,
      unit: 'days' as const,
      timezone: NY,
    };

    // currentDue was 09:30 EST (14:30Z) before spring-forward; 30 days after 2026-03-01 is 2026-03-31 (EDT, UTC-4), so 09:30 EDT = 13:30Z
    expect(
      computeNextDueDate(thirtyDays, '2026-03-01T18:00:00.000Z', '2026-03-01T14:30:00.000Z', NY, {
        dueHasTime: true,
      }),
    ).toBe('2026-03-31T13:30:00.000Z');

    // When currentDue is null and dueHasTime is true, keeps shifted completion instant
    expect(
      computeNextDueDate(thirtyDays, '2026-03-01T18:00:00.000Z', null, NY, { dueHasTime: true }),
    ).toBe('2026-03-31T17:00:00.000Z');
  });

  it('throws on invalid timezone or invalid cron expression', () => {
    expect(() =>
      computeNextDueDate(
        { type: 'cron', expression: '0 7 * * 6' },
        '2026-03-04T15:00:00.000Z',
        null,
        'Mars/Olympus',
      ),
    ).toThrow();

    expect(() =>
      computeNextDueDate(
        { type: 'cron', expression: '0 7 * *' },
        '2026-03-04T15:00:00.000Z',
        null,
        'UTC',
      ),
    ).toThrow();
  });
});
