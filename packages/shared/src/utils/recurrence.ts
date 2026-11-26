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
