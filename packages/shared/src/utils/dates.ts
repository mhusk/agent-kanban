import { DateTime } from 'luxon';
import type { CardStatus } from '../schemas/card.js';
import { isValidIanaTimezone } from '../schemas/common.js';

export interface DueCardLike {
  due: string | null;
  dueHasTime?: boolean;
  status?: CardStatus;
  archived?: boolean;
}

function assertValidTimezone(tz: string): void {
  if (!isValidIanaTimezone(tz)) {
    throw new Error(`Invalid IANA timezone: ${tz}`);
  }
}

function toLuxonDateTime(input: Date | string, zone: string): DateTime {
  const dt =
    input instanceof Date
      ? DateTime.fromJSDate(input, { zone })
      : DateTime.fromISO(input, { zone });

  if (!dt.isValid) {
    throw new Error(`Invalid date/time input: ${String(input)}`);
  }

  return dt;
}

/**
 * Resolves a card's effective due instant as a UTC Date.
 * Date-only dues (dueHasTime === false) evaluate to 23:59:59 local time in `tz`.
 */
export function resolveEffectiveDueInstant(dueIso: string, dueHasTime: boolean, tz: string): Date {
  assertValidTimezone(tz);

  const parsed = DateTime.fromISO(dueIso, { setZone: true });
  if (!parsed.isValid) {
    throw new Error(`Invalid due ISO date/time: ${dueIso}`);
  }

  if (dueHasTime) {
    return parsed.toUTC().toJSDate();
  }

  // Read the calendar date without shifting across UTC offsets so YYYY-MM-DD
  // always evaluates to 23:59:59 on that exact local calendar day in `tz`.
  const localEndOfDay = DateTime.fromObject(
    {
      year: parsed.year,
      month: parsed.month,
      day: parsed.day,
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 0,
    },
    { zone: tz },
  );

  if (!localEndOfDay.isValid) {
    throw new Error(`Unable to resolve due date in timezone ${tz}: ${dueIso}`);
  }

  return localEndOfDay.toJSDate();
}

/**
 * Returns true if an open, non-archived card's effective due instant is strictly before `now`.
 */
export function isOverdue(card: DueCardLike, now: Date | string, tz: string): boolean {
  assertValidTimezone(tz);

  if (!card.due || card.archived === true || card.status === 'done') {
    return false;
  }

  const nowDt = toLuxonDateTime(now, tz);
  const effectiveDue = resolveEffectiveDueInstant(card.due, Boolean(card.dueHasTime), tz);
  return nowDt.toMillis() > effectiveDue.getTime();
}

/**
 * Returns true if an open, non-archived card is not yet overdue and its effective due
 * falls within `windowDays` (default 2) of `now` in `tz`.
 */
export function isDueSoon(
  card: DueCardLike,
  now: Date | string,
  tz: string,
  windowDays = 2,
): boolean {
  assertValidTimezone(tz);

  if (!Number.isFinite(windowDays) || windowDays < 0) {
    throw new RangeError('windowDays must be a non-negative finite number');
  }

  if (!card.due || card.archived === true || card.status === 'done') {
    return false;
  }

  const nowInTz = toLuxonDateTime(now, tz);
  const hasTime = Boolean(card.dueHasTime);
  const effectiveDueMs = resolveEffectiveDueInstant(card.due, hasTime, tz).getTime();

  if (nowInTz.toMillis() > effectiveDueMs) {
    return false;
  }

  const horizon = hasTime
    ? nowInTz.plus({ days: windowDays })
    : nowInTz.plus({ days: windowDays }).set({
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 0,
      });

  return effectiveDueMs <= horizon.toMillis();
}
