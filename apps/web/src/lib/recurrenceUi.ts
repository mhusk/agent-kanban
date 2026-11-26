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
  };
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
    return {
      ...base,
      mode: 'interval_after_completion',
      intervalEvery: recurrence.every,
      intervalUnit: recurrence.unit,
      timezone: recurrence.timezone ?? '',
    };
  }

  const parsed = parseStandardCron(recurrence.expression);
  if (parsed) {
    return {
      ...base,
      mode: parsed.mode,
      time: `${pad2(parsed.hour)}:${pad2(parsed.minute)}`,
      weekdays: parsed.weekdays,
      dayOfMonth: parsed.dayOfMonth,
      cronExpression: recurrence.expression,
      timezone: recurrence.timezone ?? '',
    };
  }

  return {
    ...base,
    mode: 'cron',
    cronExpression: recurrence.expression,
    timezone: recurrence.timezone ?? '',
  };
}

export function formStateToRecurrence(state: RecurrenceFormState): Recurrence | null {
  const tz = state.timezone.trim();
  const tzField = tz.length > 0 ? { timezone: tz } : {};
  const { hour, minute } = parseTimeParts(state.time);

  switch (state.mode) {
    case 'none':
      return null;
    case 'daily':
      return {
        type: 'cron',
        expression: `${minute} ${hour} * * *`,
        ...tzField,
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
      };
    }
    case 'monthly': {
      const dom = Math.max(1, Math.min(31, Math.floor(Number(state.dayOfMonth) || 1)));
      return {
        type: 'cron',
        expression: `${minute} ${hour} ${dom} * *`,
        ...tzField,
      };
    }
    case 'interval_after_completion':
      return {
        type: 'interval_after_completion',
        every: Math.max(1, Math.min(3650, Math.floor(Number(state.intervalEvery) || 1))),
        unit: state.intervalUnit,
        ...tzField,
      };
    case 'cron':
      return {
        type: 'cron',
        expression: state.cronExpression.trim(),
        ...tzField,
      };
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
    return a.expression.trim() === b.expression.trim();
  }
  if (a.type === 'interval_after_completion' && b.type === 'interval_after_completion') {
    return a.every === b.every && a.unit === b.unit;
  }
  return false;
}
