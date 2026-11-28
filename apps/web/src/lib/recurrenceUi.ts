import type { Recurrence, RecurrenceUnit } from '@agent-kanban/shared';

export type RecurrenceMode =
  'none' | 'daily' | 'weekly' | 'monthly' | 'interval_after_completion' | 'cron';

export interface RecurrenceFormState {
  mode: RecurrenceMode;
  time: string;
  weekdays: number[];
  dayOfMonth: number;
  intervalEvery: number;
  intervalUnit: RecurrenceUnit;
  cronExpression: string;
  timezone: string;
  /** When false, completing the card leaves it on To-Do. */
  autoDefer: boolean;
  /** Empty string keeps the smart cadence default. Otherwise a whole number 0–365. */
  leadDaysInput: string;
}

export const WEEKDAY_OPTIONS: ReadonlyArray<{
  value: number;
  shortLabel: string;
  fullLabel: string;
}> = [
  { value: 0, shortLabel: 'Sun', fullLabel: 'Sunday' },
  { value: 1, shortLabel: 'Mon', fullLabel: 'Monday' },
  { value: 2, shortLabel: 'Tue', fullLabel: 'Tuesday' },
  { value: 3, shortLabel: 'Wed', fullLabel: 'Wednesday' },
  { value: 4, shortLabel: 'Thu', fullLabel: 'Thursday' },
  { value: 5, shortLabel: 'Fri', fullLabel: 'Friday' },
  { value: 6, shortLabel: 'Sat', fullLabel: 'Saturday' },
];

export function createDefaultRecurrenceFormState(defaultWeekday = 6): RecurrenceFormState {
  return {
    mode: 'none',
    time: '09:00',
    weekdays: [defaultWeekday],
    dayOfMonth: 1,
    intervalEvery: 7,
    intervalUnit: 'days',
    cronExpression: '0 9 * * 6',
    timezone: '',
    autoDefer: true,
    leadDaysInput: '',
  };
}

export function parseLeadDaysInput(raw: string): number | undefined | 'invalid' {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    return 'invalid';
  }
  const value = Number(trimmed);
  if (value > 365) {
    return 'invalid';
  }
  return value;
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

function minimumWeekdayGap(weekdays: number[]): number {
  if (weekdays.length <= 1) {
    return 7;
  }
  const sorted = [...weekdays].sort((a, b) => a - b);
  let minGap = 7;
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const next = sorted[(index + 1) % sorted.length]!;
    const gap = index === sorted.length - 1 ? next + 7 - current : next - current;
    if (gap > 0 && gap < minGap) {
      minGap = gap;
    }
  }
  return minGap;
}

/**
 * Cadence-sized stand-in for `resolveDefaultLeadDays` when the editor has no
 * concrete next due yet: 0 under 7 days, 1 day for 7–13, 3 days at 14+.
 */
export function estimateSmartLeadDays(recurrence: Recurrence): number {
  switch (recurrence.type) {
    case 'interval_after_completion': {
      switch (recurrence.unit) {
        case 'days':
          return leadDaysForCadenceSpan(recurrence.every);
        case 'weeks':
          return leadDaysForCadenceSpan(recurrence.every * 7);
        case 'months':
          return leadDaysForCadenceSpan(recurrence.every * 30);
        default: {
          const unsupported: never = recurrence.unit;
          throw new Error(`Unsupported recurrence unit: ${String(unsupported)}`);
        }
      }
    }
    case 'cron': {
      const parsed = parseStandardCron(recurrence.expression);
      if (!parsed) {
        return 3;
      }
      switch (parsed.mode) {
        case 'daily':
          return 0;
        case 'weekly':
          return leadDaysForCadenceSpan(minimumWeekdayGap(parsed.weekdays));
        case 'monthly':
          return 3;
        default: {
          const unsupported: never = parsed.mode;
          throw new Error(`Unsupported cadence: ${String(unsupported)}`);
        }
      }
    }
    default: {
      const unsupported: never = recurrence;
      throw new Error(`Unsupported recurrence type: ${String(unsupported)}`);
    }
  }
}

export function describeSmartLeadDays(recurrence: Recurrence | null): string {
  if (recurrence === null) {
    return 'Smart default applies once a repeat schedule is set';
  }
  const days = estimateSmartLeadDays(recurrence);
  if (days === 0) {
    return 'Smart default: reappear on the due date';
  }
  if (days === 1) {
    return 'Smart default: reappear 1 day before due';
  }
  return `Smart default: reappear ${days} days before due`;
}

function attachStoredNudges(
  state: RecurrenceFormState,
  recurrence: Recurrence,
): RecurrenceFormState {
  return {
    ...state,
    autoDefer: recurrence.autoDefer !== false,
    leadDaysInput: recurrence.leadDays === undefined ? '' : String(recurrence.leadDays),
  };
}

function recurrenceNudgeFields(state: RecurrenceFormState): {
  autoDefer?: false;
  leadDays?: number;
} {
  const fields: { autoDefer?: false; leadDays?: number } = {};
  if (!state.autoDefer) {
    fields.autoDefer = false;
  }
  const leadDays = parseLeadDaysInput(state.leadDaysInput);
  if (typeof leadDays === 'number') {
    fields.leadDays = leadDays;
  }
  return fields;
}

function nudgesEqual(a: Recurrence, b: Recurrence): boolean {
  const sameAutoDefer = (a.autoDefer !== false) === (b.autoDefer !== false);
  return sameAutoDefer && (a.leadDays ?? null) === (b.leadDays ?? null);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseTimeParts(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) {
    return { hour: 9, minute: 0 };
  }
  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  return { hour, minute };
}

function formatClockTime(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${pad2(minute)} ${period}`;
}

function formatOrdinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${day}th`;
  }
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

interface ParsedStandardCron {
  mode: 'daily' | 'weekly' | 'monthly';
  hour: number;
  minute: number;
  weekdays: number[];
  dayOfMonth: number;
}

function parseStandardCron(expression: string): ParsedStandardCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }
  const [minStr, hourStr, domStr, monthStr, dowStr] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d{1,2}$/.test(minStr) || !/^\d{1,2}$/.test(hourStr) || monthStr !== '*') {
    return null;
  }
  const minute = Number(minStr);
  const hour = Number(hourStr);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    return null;
  }

  if (domStr === '*' && dowStr === '*') {
    return { mode: 'daily', hour, minute, weekdays: [6], dayOfMonth: 1 };
  }

  if (domStr === '*' && /^[0-7](?:,[0-7])*$/.test(dowStr)) {
    const normalized = Array.from(
      new Set(
        dowStr
          .split(',')
          .map((d) => Number(d) % 7)
          .filter((d) => d >= 0 && d <= 6),
      ),
    ).sort((a, b) => a - b);
    if (normalized.length > 0) {
      return { mode: 'weekly', hour, minute, weekdays: normalized, dayOfMonth: 1 };
    }
  }

  if (dowStr === '*' && /^\d{1,2}$/.test(domStr)) {
    const dayOfMonth = Number(domStr);
    if (dayOfMonth >= 1 && dayOfMonth <= 31) {
      return { mode: 'monthly', hour, minute, weekdays: [6], dayOfMonth };
    }
  }

  return null;
}

export function recurrenceToFormState(
  recurrence: Recurrence | null,
  defaultWeekday = 6,
): RecurrenceFormState {
  const base = createDefaultRecurrenceFormState(defaultWeekday);
  if (recurrence === null) {
    return base;
  }

  if (recurrence.type === 'interval_after_completion') {
    return attachStoredNudges(
      {
        ...base,
        mode: 'interval_after_completion',
        intervalEvery: recurrence.every,
        intervalUnit: recurrence.unit,
        timezone: recurrence.timezone ?? '',
      },
      recurrence,
    );
  }

  const parsed = parseStandardCron(recurrence.expression);
  if (parsed) {
    return attachStoredNudges(
      {
        ...base,
        mode: parsed.mode,
        time: `${pad2(parsed.hour)}:${pad2(parsed.minute)}`,
        weekdays: parsed.weekdays,
        dayOfMonth: parsed.dayOfMonth,
        cronExpression: recurrence.expression,
        timezone: recurrence.timezone ?? '',
      },
      recurrence,
    );
  }

  return attachStoredNudges(
    {
      ...base,
      mode: 'cron',
      cronExpression: recurrence.expression,
      timezone: recurrence.timezone ?? '',
    },
    recurrence,
  );
}

export function formStateToRecurrence(state: RecurrenceFormState): Recurrence | null {
  const tz = state.timezone.trim();
  const tzField = tz.length > 0 ? { timezone: tz } : {};
  const nudgeFields = recurrenceNudgeFields(state);
  const { hour, minute } = parseTimeParts(state.time);

  switch (state.mode) {
    case 'none':
      return null;
    case 'daily':
      return {
        type: 'cron',
        expression: `${minute} ${hour} * * *`,
        ...tzField,
        ...nudgeFields,
      };
    case 'weekly': {
      const days =
        state.weekdays.length > 0
          ? Array.from(new Set(state.weekdays.map((d) => ((d % 7) + 7) % 7))).sort((a, b) => a - b)
          : [6];
      return {
        type: 'cron',
        expression: `${minute} ${hour} * * ${days.join(',')}`,
        ...tzField,
        ...nudgeFields,
      };
    }
    case 'monthly': {
      const dom = Math.max(1, Math.min(31, Math.floor(Number(state.dayOfMonth) || 1)));
      return {
        type: 'cron',
        expression: `${minute} ${hour} ${dom} * *`,
        ...tzField,
        ...nudgeFields,
      };
    }
    case 'interval_after_completion':
      return {
        type: 'interval_after_completion',
        every: Math.max(1, Math.min(3650, Math.floor(Number(state.intervalEvery) || 1))),
        unit: state.intervalUnit,
        ...tzField,
        ...nudgeFields,
      };
    case 'cron':
      return {
        type: 'cron',
        expression: state.cronExpression.trim(),
        ...tzField,
        ...nudgeFields,
      };
    default: {
      const unsupported: never = state.mode;
      throw new Error(`Unsupported recurrence mode: ${String(unsupported)}`);
    }
  }
}

export function describeRecurrence(recurrence: Recurrence | null): string {
  if (recurrence === null) {
    return 'Does not repeat';
  }

  if (recurrence.type === 'interval_after_completion') {
    const unitLabel = recurrence.every === 1 ? recurrence.unit.replace(/s$/, '') : recurrence.unit;
    return `Every ${recurrence.every} ${unitLabel} after completion`;
  }

  const parsed = parseStandardCron(recurrence.expression);
  if (!parsed) {
    return `Custom schedule (${recurrence.expression})`;
  }

  const clock = formatClockTime(parsed.hour, parsed.minute);
  if (parsed.mode === 'daily') {
    return `Every day at ${clock}`;
  }
  if (parsed.mode === 'weekly') {
    if (parsed.weekdays.length === 7) {
      return `Every day at ${clock}`;
    }
    if (parsed.weekdays.length === 1) {
      const full = WEEKDAY_OPTIONS[parsed.weekdays[0]!]?.fullLabel ?? 'week';
      return `Every ${full} at ${clock}`;
    }
    const shortList = parsed.weekdays
      .map((day) => WEEKDAY_OPTIONS[day]?.shortLabel ?? String(day))
      .join(', ');
    return `Every ${shortList} at ${clock}`;
  }

  return `Monthly on the ${formatOrdinal(parsed.dayOfMonth)} at ${clock}`;
}

export function recurrencesEqual(a: Recurrence | null, b: Recurrence | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.type !== b.type || (a.timezone ?? '') !== (b.timezone ?? '')) {
    return false;
  }
  if (a.type === 'cron' && b.type === 'cron') {
    return a.expression.trim() === b.expression.trim() && nudgesEqual(a, b);
  }
  if (a.type === 'interval_after_completion' && b.type === 'interval_after_completion') {
    return a.every === b.every && a.unit === b.unit && nudgesEqual(a, b);
  }
  return false;
}
