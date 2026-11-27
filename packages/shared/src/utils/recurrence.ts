import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
import { isValidFiveFieldCron, type Recurrence } from '../schemas/card.js';
import { isValidIanaTimezone } from '../schemas/common.js';

export interface ComputeNextDueDateOptions {
  dueHasTime?: boolean;
}

function toLuxonInZone(input: Date | string, zone: string): DateTime {
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
 * Computes the next UTC ISO due date/time for a recurring card upon completion.
 */
export function computeNextDueDate(
  recurrence: Recurrence,
  completedAt: Date | string,
  currentDue: string | null,
  defaultTz = 'UTC',
  options?: ComputeNextDueDateOptions,
): string {
  const tz = recurrence.timezone ?? defaultTz;
  if (!isValidIanaTimezone(tz)) {
    throw new Error(`Invalid IANA timezone: ${tz}`);
  }

  const completedInTz = toLuxonInZone(completedAt, tz);

  if (recurrence.type === 'cron') {
    if (!isValidFiveFieldCron(recurrence.expression)) {
      throw new Error(`Invalid 5-field cron expression: ${recurrence.expression}`);
    }

    let anchor = completedInTz;
    if (currentDue !== null) {
      let dueInZone: DateTime;
      if (options?.dueHasTime === false && currentDue.endsWith('T00:00:00.000Z')) {
        dueInZone = DateTime.fromISO(`${currentDue.slice(0, 10)}T23:59:59.999`, { zone: tz });
      } else {
        dueInZone = DateTime.fromISO(currentDue, { zone: tz });
      }
      if (dueInZone.isValid && dueInZone.toMillis() > anchor.toMillis()) {
        anchor = dueInZone;
      }
    }

    const expr = CronExpressionParser.parse(recurrence.expression, {
      currentDate: anchor.toJSDate(),
      tz,
    });

    let nextDate = expr.next().toDate();
    while (nextDate.getTime() <= anchor.toMillis()) {
      nextDate = expr.next().toDate();
    }

    return nextDate.toISOString();
  }

  if (!Number.isInteger(recurrence.every) || recurrence.every < 1) {
    throw new Error(`Invalid recurrence interval: ${recurrence.every}`);
  }

  const shifted = completedInTz.plus({ [recurrence.unit]: recurrence.every });
  if (!shifted.isValid) {
    throw new Error('Failed to compute shifted recurrence date');
  }

  if (options?.dueHasTime === true) {
    let target = shifted;
    if (currentDue !== null) {
      const currentDueInTz = DateTime.fromISO(currentDue, { zone: tz });
      if (!currentDueInTz.isValid) {
        throw new Error(`Invalid currentDue ISO date/time: ${currentDue}`);
      }
      target = shifted.set({
        hour: currentDueInTz.hour,
        minute: currentDueInTz.minute,
        second: currentDueInTz.second,
        millisecond: currentDueInTz.millisecond,
      });
      if (target.toMillis() <= currentDueInTz.toMillis()) {
        target = currentDueInTz.plus({ [recurrence.unit]: recurrence.every });
      }
    }

    const iso = target.toUTC().toISO();
    if (!iso) {
      throw new Error('Failed to format next due date as ISO string');
    }
    return iso;
  }

  let targetDate: DateTime = DateTime.utc(shifted.year, shifted.month, shifted.day, 0, 0, 0, 0);
  if (currentDue !== null) {
    let dueDateUtc: DateTime;
    if (currentDue.endsWith('T00:00:00.000Z')) {
      const [y, m, d] = currentDue.slice(0, 10).split('-').map(Number);
      dueDateUtc = DateTime.utc(y!, m!, d!, 0, 0, 0, 0);
    } else {
      const currentDueInTz = DateTime.fromISO(currentDue, { zone: tz });
      dueDateUtc = currentDueInTz.isValid
        ? DateTime.utc(currentDueInTz.year, currentDueInTz.month, currentDueInTz.day, 0, 0, 0, 0)
        : DateTime.invalid('invalid currentDue');
    }
    if (dueDateUtc.isValid && targetDate.toMillis() <= dueDateUtc.toMillis()) {
      targetDate = dueDateUtc.plus({ [recurrence.unit]: recurrence.every });
    }
  }

  const dateOnlyIso = targetDate.toISO();
  if (!dateOnlyIso) {
    throw new Error('Failed to format date-only next due date as ISO string');
  }
  return dateOnlyIso;
}

const DATE_ONLY_UTC_MIDNIGHT = /T00:00:00\.000Z$/;

function resolveRecurrenceZone(recurrence: Recurrence, defaultTz: string): string {
  const tz = recurrence.timezone ?? defaultTz;
  if (!isValidIanaTimezone(tz)) {
    throw new Error(`Invalid IANA timezone: ${tz}`);
  }
  return tz;
}

function explicitLeadDays(recurrence: Recurrence): number | undefined {
  if (recurrence.leadDays === undefined) {
    return undefined;
  }
  if (
    !Number.isInteger(recurrence.leadDays) ||
    recurrence.leadDays < 0 ||
    recurrence.leadDays > 365
  ) {
    throw new RangeError('leadDays must be an integer from 0 to 365');
  }
  return recurrence.leadDays;
}

/**
 * Calendar date of a due value in `tz`.
 * Date-only dues are stored as `YYYY-MM-DDT00:00:00.000Z` and mean that calendar
 * date, not UTC midnight converted into the previous local evening.
 */
function dueCalendarDate(nextDueIso: string, tz: string, dueHasTime?: boolean): DateTime {
  const useDatePrefix =
    dueHasTime === false || (dueHasTime === undefined && DATE_ONLY_UTC_MIDNIGHT.test(nextDueIso));

  if (useDatePrefix) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(nextDueIso);
    if (!match) {
      throw new Error(`Invalid due ISO date/time: ${nextDueIso}`);
    }
    const local = DateTime.fromObject(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
      },
      { zone: tz },
    );
    if (!local.isValid) {
      throw new Error(`Invalid due ISO date/time: ${nextDueIso}`);
    }
    return local;
  }

  const instant = DateTime.fromISO(nextDueIso, { setZone: true });
  if (!instant.isValid) {
    throw new Error(`Invalid due ISO date/time: ${nextDueIso}`);
  }

  const zoned = instant.setZone(tz);
  const local = DateTime.fromObject(
    {
      year: zoned.year,
      month: zoned.month,
      day: zoned.day,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    },
    { zone: tz },
  );
  if (!local.isValid) {
    throw new Error(`Unable to resolve due date in timezone ${tz}: ${nextDueIso}`);
  }
  return local;
}

/** Whole local calendar days from `start` to `end` (DST-safe, may be negative). */
function calendarDaysBetween(start: DateTime, end: DateTime): number {
  let cursor = start.startOf('day');
  const target = end.startOf('day');
  if (!cursor.isValid || !target.isValid) {
    throw new Error('Invalid calendar day');
  }

  const forward = target.toMillis() >= cursor.toMillis();
  let days = 0;
  while (cursor.toMillis() !== target.toMillis()) {
    cursor = cursor.plus({ days: forward ? 1 : -1 });
    if (!cursor.isValid) {
      throw new Error('Failed to walk calendar days');
    }
    days += forward ? 1 : -1;
    if (Math.abs(days) > 4000) {
      throw new Error('Calendar span exceeded supported range');
    }
  }
  return days;
}

function leadDaysForCadenceSpan(spanDays: number): number {
  if (spanDays < 7) {
    return 0;
  }
  if (spanDays <= 13) {
    return 1;
  }
  return 3;
}

/**
 * Smart lead time before the next due: 0 days when the gap is under 7 days,
 * 1 day for a 7–13 day gap, and 3 days when the gap is 14 days or more.
 * The gap is the local calendar span from `completedAt` to `nextDueIso`.
 */
export function resolveDefaultLeadDays(
  recurrence: Recurrence,
  nextDueIso: string,
  completedAt: Date | string,
  defaultTz = 'UTC',
  options?: ComputeNextDueDateOptions,
): number {
  const tz = resolveRecurrenceZone(recurrence, defaultTz);
  const completed = toLuxonInZone(completedAt, tz);
  const dueDay = dueCalendarDate(nextDueIso, tz, options?.dueHasTime);
  return leadDaysForCadenceSpan(calendarDaysBetween(completed, dueDay));
}

/**
 * Wake-up instant for a recurring card after completion.
 * Returns null when auto-defer is off, or when the computed local start-of-day
 * is not strictly after `completedAt` (the card should stay visible).
 * Otherwise returns the UTC ISO timestamp of `nextDue - leadDays` at 00:00 in `tz`.
 */
export function computeRecurrenceDeferUntil(
  recurrence: Recurrence,
  nextDueIso: string,
  completedAt: Date | string,
  defaultTz = 'UTC',
  options?: ComputeNextDueDateOptions,
): string | null {
  if (recurrence.autoDefer === false) {
    return null;
  }

  const tz = resolveRecurrenceZone(recurrence, defaultTz);
  const leadDays =
    explicitLeadDays(recurrence) ??
    resolveDefaultLeadDays(recurrence, nextDueIso, completedAt, defaultTz, options);

  const wakeLocal = dueCalendarDate(nextDueIso, tz, options?.dueHasTime).minus({ days: leadDays });
  if (!wakeLocal.isValid) {
    throw new Error('Failed to compute defer-until instant');
  }

  const completed = toLuxonInZone(completedAt, tz);
  if (wakeLocal.toMillis() <= completed.toMillis()) {
    return null;
  }

  return wakeLocal.toJSDate().toISOString();
}

/**
 * Upcoming dues for a schedule view.
 * Cron rules return `count` occurrences strictly after the later of `fromDate`
 * and `currentDue`, using the same anchor as `computeNextDueDate`.
 * Interval rules return only the next estimated due (further ones depend on
 * when the card is actually completed). `count` of 0 returns an empty list.
 */
export function projectNextOccurrences(
  recurrence: Recurrence,
  fromDate: Date | string,
  currentDue: string | null,
  count: number,
  defaultTz = 'UTC',
  options?: ComputeNextDueDateOptions,
): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('count must be a non-negative integer');
  }
  if (count === 0) {
    return [];
  }

  switch (recurrence.type) {
    case 'cron': {
      const occurrences: string[] = [];
      let cursorFrom: Date | string = fromDate;
      let cursorDue = currentDue;
      for (let index = 0; index < count; index += 1) {
        const next = computeNextDueDate(recurrence, cursorFrom, cursorDue, defaultTz, options);
        occurrences.push(next);
        cursorFrom = next;
        cursorDue = next;
      }
      return occurrences;
    }
    case 'interval_after_completion':
      return [computeNextDueDate(recurrence, fromDate, currentDue, defaultTz, options)];
    default: {
      const unsupported: never = recurrence;
      throw new Error(`Unsupported recurrence type: ${String(unsupported)}`);
    }
  }
}
