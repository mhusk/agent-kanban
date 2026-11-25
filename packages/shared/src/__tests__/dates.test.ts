import { describe, expect, it } from 'vitest';
import { isDueSoon, isOverdue, resolveEffectiveDueInstant } from '../index.js';

describe('DST-aware due date helpers', () => {
  const NY = 'America/New_York';

  it('resolves date-only dues to 23:59:59 local time without shifting UTC midnight backward', () => {
    const fromMidnightUtc = resolveEffectiveDueInstant('2026-05-15T00:00:00.000Z', false, NY);
    const fromEndOfDayUtc = resolveEffectiveDueInstant('2026-05-15T23:59:59.000Z', false, NY);
    const fromPlainDate = resolveEffectiveDueInstant('2026-05-15', false, NY);

    // May 15 in America/New_York is EDT (UTC-4), so 23:59:59 local = 2026-05-16T03:59:59.000Z
    const expected = '2026-05-16T03:59:59.000Z';
    expect(fromMidnightUtc.toISOString()).toBe(expected);
    expect(fromEndOfDayUtc.toISOString()).toBe(expected);
    expect(fromPlainDate.toISOString()).toBe(expected);

    expect(resolveEffectiveDueInstant('2026-05-15T00:00:00.000Z', false, 'UTC').toISOString()).toBe(
      '2026-05-15T23:59:59.000Z',
    );
  });

  it('handles DST spring-forward day (2026-03-08) in America/New_York accurately', () => {
    // 2026-03-08 23:59:59 in America/New_York is EDT (UTC-4) -> 2026-03-09T03:59:59.000Z
    const effective = resolveEffectiveDueInstant('2026-03-08T00:00:00.000Z', false, NY);
    expect(effective.toISOString()).toBe('2026-03-09T03:59:59.000Z');

    const card = { due: '2026-03-08T00:00:00.000Z', dueHasTime: false, status: 'todo' as const };
    expect(isOverdue(card, '2026-03-09T03:59:58.999Z', NY)).toBe(false);
    expect(isOverdue(card, '2026-03-09T03:59:59.000Z', NY)).toBe(false);
    expect(isOverdue(card, '2026-03-09T04:00:00.000Z', NY)).toBe(true);
  });

  it('handles DST fall-back day (2026-11-01) in America/New_York accurately', () => {
    // 2026-11-01 23:59:59 in America/New_York is EST (UTC-5) -> 2026-11-02T04:59:59.000Z
    const effective = resolveEffectiveDueInstant('2026-11-01T00:00:00.000Z', false, NY);
    expect(effective.toISOString()).toBe('2026-11-02T04:59:59.000Z');

    const card = { due: '2026-11-01T00:00:00.000Z', dueHasTime: false, status: 'doing' as const };
    expect(isOverdue(card, '2026-11-02T04:59:59.000Z', NY)).toBe(false);
    expect(isOverdue(card, '2026-11-02T05:00:00.000Z', NY)).toBe(true);
  });

  it('preserves exact instant when dueHasTime is true', () => {
    const dueIso = '2026-03-08T14:30:00.000Z';
    expect(resolveEffectiveDueInstant(dueIso, true, NY).toISOString()).toBe(dueIso);

    const card = { due: dueIso, dueHasTime: true, status: 'todo' as const };
    expect(isOverdue(card, '2026-03-08T14:30:00.000Z', NY)).toBe(false);
    expect(isOverdue(card, '2026-03-08T14:30:00.001Z', NY)).toBe(true);
  });

  it('evaluates isDueSoon for date-only and timed dues across DST and ignores done/archived/null', () => {
    // Spring-forward: now is 2026-03-07 10:00 EST (15:00Z). windowDays=2 -> end of 2026-03-09 EDT
    const dateCard = {
      due: '2026-03-09T00:00:00.000Z',
      dueHasTime: false,
      status: 'todo' as const,
    };
    expect(isDueSoon(dateCard, '2026-03-07T15:00:00.000Z', NY, 2)).toBe(true);
    expect(isDueSoon(dateCard, '2026-03-07T15:00:00.000Z', NY, 1)).toBe(false);

    // Timed card: 2026-11-01T14:00:00Z (10:00 EDT / 09:00 EST after fallback)
    const timedCard = {
      due: '2026-11-02T14:00:00.000Z',
      dueHasTime: true,
      status: 'todo' as const,
    };
    // 48h prior is 2026-10-31T14:00:00.000Z (before fall-back, Luxon plus({days:2}) lands at 10:00 EST = 15:00Z)
    expect(isDueSoon(timedCard, '2026-10-31T14:00:00.000Z', NY, 2)).toBe(true);
    expect(isDueSoon(timedCard, '2026-10-31T12:00:00.000Z', NY, 2)).toBe(false);

    // Overdue card is NOT dueSoon
    expect(isDueSoon(dateCard, '2026-03-10T12:00:00.000Z', NY, 2)).toBe(false);

    // Null due, done, or archived return false for both isOverdue and isDueSoon
    expect(isOverdue({ due: null }, '2026-05-01T00:00:00.000Z', NY)).toBe(false);
    expect(isDueSoon({ due: null }, '2026-05-01T00:00:00.000Z', NY)).toBe(false);
    expect(isOverdue({ ...dateCard, status: 'done' }, '2026-05-01T00:00:00.000Z', NY)).toBe(false);
    expect(isDueSoon({ ...dateCard, archived: true }, '2026-03-08T12:00:00.000Z', NY)).toBe(false);
  });

  it('throws on invalid timezone or invalid ISO date strings', () => {
    expect(() =>
      resolveEffectiveDueInstant('2026-05-15T00:00:00.000Z', false, 'Invalid/Zone'),
    ).toThrow();
    expect(() => resolveEffectiveDueInstant('not-a-date', false, 'UTC')).toThrow();
    expect(() => isDueSoon({ due: '2026-05-15T00:00:00.000Z' }, '2026-05-14', 'UTC', -1)).toThrow(
      RangeError,
    );
  });
});
