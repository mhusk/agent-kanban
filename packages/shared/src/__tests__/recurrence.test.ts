import { describe, expect, it } from 'vitest';
import {
  computeNextDueDate,
  computeRecurrenceDeferUntil,
  projectNextOccurrences,
  resolveDefaultLeadDays,
} from '../index.js';

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

  it('advances strictly past a future currentDue when completed early (cron and interval)', () => {
    const saturdayCron = {
      type: 'cron' as const,
      expression: '0 7 * * 6',
      timezone: NY,
    };

    // Completed Thu Nov 26 while already due Sat Nov 28 07:00 EST -> advances to Sat Dec 5 07:00 EST (12:00Z)
    expect(
      computeNextDueDate(saturdayCron, '2026-11-26T17:00:00.000Z', '2026-11-28T12:00:00.000Z', NY, {
        dueHasTime: true,
      }),
    ).toBe('2026-12-05T12:00:00.000Z');

    // Date-only currentDue on Sat Nov 28 completed Thu Nov 26 -> also advances to Sat Dec 5
    expect(
      computeNextDueDate(saturdayCron, '2026-11-26T17:00:00.000Z', '2026-11-28T00:00:00.000Z', NY, {
        dueHasTime: false,
      }),
    ).toBe('2026-12-05T12:00:00.000Z');

    const weeklyInterval = {
      type: 'interval_after_completion' as const,
      every: 7,
      unit: 'days' as const,
      timezone: NY,
    };

    // Already due Dec 3 (completed Nov 26, +7d = Dec 3) -> advances +7d past currentDue to Dec 10
    expect(
      computeNextDueDate(
        weeklyInterval,
        '2026-11-26T17:00:00.000Z',
        '2026-12-03T00:00:00.000Z',
        NY,
        {
          dueHasTime: false,
        },
      ),
    ).toBe('2026-12-10T00:00:00.000Z');

    // Slightly early (due Nov 28, completed Nov 26, +7d = Dec 3 > Nov 28) -> uses Dec 3
    expect(
      computeNextDueDate(
        weeklyInterval,
        '2026-11-26T17:00:00.000Z',
        '2026-11-28T00:00:00.000Z',
        NY,
        {
          dueHasTime: false,
        },
      ),
    ).toBe('2026-12-03T00:00:00.000Z');
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

describe('recurrence lead days and defer-until', () => {
  const NY = 'America/New_York';
  const daily: {
    type: 'interval_after_completion';
    every: number;
    unit: 'days';
    timezone?: string;
    autoDefer?: boolean;
    leadDays?: number;
  } = {
    type: 'interval_after_completion',
    every: 1,
    unit: 'days',
  };

  it('uses cadence defaults from the calendar span between completion and next due', () => {
    const completedAt = '2026-01-01T12:00:00.000Z';
    const cases: Array<{ due: string; lead: number }> = [
      { due: '2026-01-01T00:00:00.000Z', lead: 0 },
      { due: '2026-01-07T00:00:00.000Z', lead: 0 },
      { due: '2026-01-08T00:00:00.000Z', lead: 1 },
      { due: '2026-01-14T00:00:00.000Z', lead: 1 },
      { due: '2026-01-15T00:00:00.000Z', lead: 3 },
      { due: '2026-01-31T00:00:00.000Z', lead: 3 },
    ];

    for (const testCase of cases) {
      expect(resolveDefaultLeadDays(daily, testCase.due, completedAt, 'UTC')).toBe(testCase.lead);
    }

    // Weekly cron completed on its tick (next due is 7 days out) vs completed early (3 days out).
    const saturday = { type: 'cron' as const, expression: '0 7 * * 6', timezone: NY };
    expect(
      resolveDefaultLeadDays(saturday, '2026-03-14T11:00:00.000Z', '2026-03-07T12:00:00.000Z', NY, {
        dueHasTime: true,
      }),
    ).toBe(1);
    expect(
      resolveDefaultLeadDays(saturday, '2026-03-07T12:00:00.000Z', '2026-03-04T15:00:00.000Z', NY, {
        dueHasTime: true,
      }),
    ).toBe(0);
  });

  it('measures the span in the recurrence timezone, including a DST week', () => {
    const rule = { ...daily, timezone: NY };
    // 2026-05-02T01:30Z is still May 1 in America/New_York, so the span to May 8 is 7 days.
    expect(
      resolveDefaultLeadDays(rule, '2026-05-08T00:00:00.000Z', '2026-05-02T01:30:00.000Z', 'UTC'),
    ).toBe(1);
    expect(
      resolveDefaultLeadDays(
        { ...daily, timezone: 'UTC' },
        '2026-05-08T00:00:00.000Z',
        '2026-05-02T01:30:00.000Z',
        NY,
      ),
    ).toBe(0);

    // March 7 23:00 EST through March 14 01:00 EDT is 7 local calendar days across spring-forward.
    expect(
      resolveDefaultLeadDays(rule, '2026-03-14T05:00:00.000Z', '2026-03-08T04:00:00.000Z', 'UTC', {
        dueHasTime: true,
      }),
    ).toBe(1);
  });

  it('returns null when autoDefer is false, and otherwise the local start of nextDue minus leadDays', () => {
    const completedAt = '2026-05-01T15:00:00.000Z';
    const nextDue = '2026-06-01T00:00:00.000Z';
    const monthly = { ...daily, timezone: NY, every: 30 };

    expect(computeRecurrenceDeferUntil(monthly, nextDue, completedAt, NY)).toBe(
      '2026-05-29T04:00:00.000Z',
    );
    expect(
      computeRecurrenceDeferUntil({ ...monthly, autoDefer: true }, nextDue, completedAt, NY),
    ).toBe('2026-05-29T04:00:00.000Z');
    expect(
      computeRecurrenceDeferUntil(
        { ...monthly, autoDefer: false, leadDays: 1 },
        nextDue,
        completedAt,
        NY,
      ),
    ).toBeNull();

    expect(computeRecurrenceDeferUntil({ ...monthly, leadDays: 1 }, nextDue, completedAt, NY)).toBe(
      '2026-05-31T04:00:00.000Z',
    );
    expect(computeRecurrenceDeferUntil({ ...monthly, leadDays: 0 }, nextDue, completedAt, NY)).toBe(
      '2026-06-01T04:00:00.000Z',
    );
  });

  it('uses local midnight across the spring-forward and fall-back days', () => {
    const rule = { ...daily, timezone: NY, leadDays: 1 };
    const completedEarly = '2026-03-01T15:00:00.000Z';

    // Due March 9 (EDT). One day before is March 8 00:00, which is still EST.
    expect(
      computeRecurrenceDeferUntil(rule, '2026-03-09T00:00:00.000Z', completedEarly, NY, {
        dueHasTime: false,
      }),
    ).toBe('2026-03-08T05:00:00.000Z');

    // Timed due Saturday 07:00 EDT. Lead of 1 wakes Friday 00:00 EDT.
    expect(
      computeRecurrenceDeferUntil(
        { ...rule, leadDays: 1 },
        '2026-03-14T11:00:00.000Z',
        completedEarly,
        NY,
        { dueHasTime: true },
      ),
    ).toBe('2026-03-13T04:00:00.000Z');

    // Due Nov 2 (EST). One day before is Nov 1 00:00, which is still EDT.
    expect(
      computeRecurrenceDeferUntil(rule, '2026-11-02T00:00:00.000Z', '2026-10-20T15:00:00.000Z', NY),
    ).toBe('2026-11-01T04:00:00.000Z');

    // Due Nov 3. One day before is Nov 2 00:00 EST.
    expect(
      computeRecurrenceDeferUntil(rule, '2026-11-03T00:00:00.000Z', '2026-10-20T15:00:00.000Z', NY),
    ).toBe('2026-11-02T05:00:00.000Z');
  });

  it('returns null when the wake-up instant is not strictly after completion', () => {
    const rule = { ...daily, timezone: NY, leadDays: 0 };
    expect(
      computeRecurrenceDeferUntil(rule, '2026-03-08T00:00:00.000Z', '2026-03-08T05:00:00.000Z', NY),
    ).toBeNull();
    expect(
      computeRecurrenceDeferUntil(rule, '2026-03-08T00:00:00.000Z', '2026-03-08T05:00:00.001Z', NY),
    ).toBeNull();
    expect(
      computeRecurrenceDeferUntil(rule, '2026-03-08T00:00:00.000Z', '2026-03-07T15:00:00.000Z', NY),
    ).toBe('2026-03-08T05:00:00.000Z');
  });
});

describe('projectNextOccurrences', () => {
  const NY = 'America/New_York';
  const saturdayCron = {
    type: 'cron' as const,
    expression: '0 7 * * 6',
    timezone: NY,
  };

  it('projects cron occurrences across spring-forward and fall-back', () => {
    expect(projectNextOccurrences(saturdayCron, '2026-03-04T15:00:00.000Z', null, 3, NY)).toEqual([
      '2026-03-07T12:00:00.000Z',
      '2026-03-14T11:00:00.000Z',
      '2026-03-21T11:00:00.000Z',
    ]);

    expect(projectNextOccurrences(saturdayCron, '2026-10-30T16:00:00.000Z', null, 3, NY)).toEqual([
      '2026-10-31T11:00:00.000Z',
      '2026-11-07T12:00:00.000Z',
      '2026-11-14T12:00:00.000Z',
    ]);

    expect(
      projectNextOccurrences(
        saturdayCron,
        '2026-11-26T17:00:00.000Z',
        '2026-11-28T12:00:00.000Z',
        1,
        NY,
        { dueHasTime: true },
      ),
    ).toEqual([
      computeNextDueDate(saturdayCron, '2026-11-26T17:00:00.000Z', '2026-11-28T12:00:00.000Z', NY, {
        dueHasTime: true,
      }),
    ]);
  });

  it('returns only the next interval estimate, and nothing when count is 0', () => {
    const thirtyDays = {
      type: 'interval_after_completion' as const,
      every: 30,
      unit: 'days' as const,
      timezone: NY,
    };

    expect(
      projectNextOccurrences(thirtyDays, '2026-05-02T01:30:00.000Z', null, 5, NY, {
        dueHasTime: false,
      }),
    ).toEqual([
      computeNextDueDate(thirtyDays, '2026-05-02T01:30:00.000Z', null, NY, { dueHasTime: false }),
    ]);
    expect(projectNextOccurrences(saturdayCron, '2026-03-04T15:00:00.000Z', null, 0, NY)).toEqual(
      [],
    );
    expect(projectNextOccurrences(thirtyDays, '2026-05-02T01:30:00.000Z', null, 0, NY)).toEqual([]);
  });

  it('rejects a negative count and an invalid timezone', () => {
    expect(() =>
      projectNextOccurrences(saturdayCron, '2026-03-04T15:00:00.000Z', null, -1, NY),
    ).toThrow(RangeError);
    expect(() =>
      projectNextOccurrences(
        { type: 'cron', expression: '0 7 * * 6' },
        '2026-03-04T15:00:00.000Z',
        null,
        1,
        'Mars/Olympus',
      ),
    ).toThrow();
  });
});
