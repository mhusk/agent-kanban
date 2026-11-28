import { isCardDeferred, type Card } from '@agent-kanban/shared';

export type ScheduleBucketId = 'now' | 'next7' | 'next30' | 'later';

export const SCHEDULE_BUCKETS: ReadonlyArray<{ id: ScheduleBucketId; title: string }> = [
  { id: 'now', title: 'Due / Active Now' },
  { id: 'next7', title: 'Next 7 Days' },
  { id: 'next30', title: 'Next 30 Days' },
  { id: 'later', title: 'Later' },
];

const DATE_ONLY_UTC_MIDNIGHT = /T00:00:00\.000Z$/;
const MS_PER_DAY = 86_400_000;

export interface ScheduleCardRef {
  card: Card;
  nextOccurrences: string[];
  cadence: string;
  effectiveLeadDays: number;
}

export interface UpcomingTimelineItem {
  key: string;
  card: Card;
  bucket: ScheduleBucketId;
  kind: 'active' | 'snoozed' | 'occurrence';
  whenIso: string | null;
  dateOnly: boolean;
  wakesLabel: string | null;
  snoozedLabel: string | null;
  cadence: string | null;
  sortOffset: number;
}

export interface SnoozePreset {
  id: 'tomorrow' | 'monday' | 'week';
  label: string;
  deferUntil: string;
}

export function isDateOnlyInstant(iso: string): boolean {
  return DATE_ONLY_UTC_MIDNIGHT.test(iso);
}

export function calendarDayKey(iso: string, timeZone: string, dateOnly: boolean): string {
  if (dateOnly) {
    return iso.slice(0, 10);
  }

  const instant = new Date(iso);
  const zone = safeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function calendarDayOffset(targetKey: string, todayKey: string): number {
  const [targetYear, targetMonth, targetDay] = targetKey.split('-').map(Number);
  const [todayYear, todayMonth, todayDay] = todayKey.split('-').map(Number);
  const targetUtc = Date.UTC(targetYear!, targetMonth! - 1, targetDay!);
  const todayUtc = Date.UTC(todayYear!, todayMonth! - 1, todayDay!);
  return Math.round((targetUtc - todayUtc) / MS_PER_DAY);
}

export function bucketForDayOffset(offset: number): ScheduleBucketId {
  if (offset <= 0) {
    return 'now';
  }
  if (offset <= 7) {
    return 'next7';
  }
  if (offset <= 30) {
    return 'next30';
  }
  return 'later';
}

export function formatSnoozeChips(
  deferUntil: string,
  timeZone: string,
  now: Date,
): { wakesLabel: string; snoozedLabel: string } {
  const zone = safeTimeZone(timeZone);
  const todayKey = calendarDayKey(now.toISOString(), zone, false);
  const wakeKey = calendarDayKey(deferUntil, zone, false);
  const offset = calendarDayOffset(wakeKey, todayKey);
  const wakesLabel =
    offset <= 0 ? 'Wakes today' : offset === 1 ? 'Wakes in 1d' : `Wakes in ${offset}d`;
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
  }).format(new Date(deferUntil));
  const snoozedLabel = offset <= 0 ? 'Snoozed until today' : `Snoozed until ${weekday}`;
  return { wakesLabel, snoozedLabel };
}

export function formatScheduleInstant(
  iso: string | null,
  timeZone: string,
  dateOnly = false,
): string {
  if (iso === null) {
    return 'No due date';
  }
  if (dateOnly || isDateOnlyInstant(iso)) {
    const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(year!, month! - 1, day!)));
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: safeTimeZone(timeZone),
  }).format(new Date(iso));
}

export function formatLastCompletedSummary(iso: string | null, timeZone: string): string {
  if (iso === null) {
    return 'Not completed yet';
  }
  return `Last completed ${formatScheduleInstant(iso, timeZone, false)}`;
}

export function formatLeadDaysSummary(
  effectiveLeadDays: number,
  autoDefer: boolean | undefined,
): string {
  if (autoDefer === false) {
    return 'Stays visible until you snooze it';
  }
  if (effectiveLeadDays <= 0) {
    return 'Wakes on the due date';
  }
  if (effectiveLeadDays === 1) {
    return 'Wakes 1 day before due';
  }
  return `Wakes ${effectiveLeadDays} days before due`;
}

export function countSnoozedCards(
  input: { recurring: ReadonlyArray<{ card: Card }>; deferredCards: readonly Card[] },
  now: Date = new Date(),
): number {
  let count = 0;
  for (const entry of input.recurring) {
    if (isCardDeferred(entry.card, now)) {
      count += 1;
    }
  }
  for (const card of input.deferredCards) {
    if (isCardDeferred(card, now)) {
      count += 1;
    }
  }
  return count;
}

export function buildUpcomingTimeline(
  input: {
    timezone: string;
    recurring: readonly ScheduleCardRef[];
    deferredCards: readonly Card[];
  },
  now: Date = new Date(),
): UpcomingTimelineItem[] {
  const zone = input.timezone.trim().length > 0 ? input.timezone : 'UTC';
  const items: UpcomingTimelineItem[] = [];

  for (const entry of input.recurring) {
    const deferred = isCardDeferred(entry.card, now) && entry.card.deferUntil !== null;
    if (deferred && entry.card.deferUntil !== null) {
      items.push(snoozedItem(entry.card, entry.card.deferUntil, entry.cadence, zone, now));
    } else {
      items.push(activeItem(entry, zone, now));
    }

    const represented = new Set<string>();
    if (!deferred && entry.card.due !== null) {
      represented.add(entry.card.due);
    }
    entry.nextOccurrences.forEach((occurrence, index) => {
      if (represented.has(occurrence)) {
        return;
      }
      const dateOnly = isDateOnlyInstant(occurrence);
      const offset = dayOffset(occurrence, zone, now, dateOnly);
      if (offset < 0) {
        return;
      }
      items.push({
        key: `${entry.card.id}:occ:${index}:${occurrence}`,
        card: entry.card,
        bucket: bucketForDayOffset(offset),
        kind: 'occurrence',
        whenIso: occurrence,
        dateOnly,
        wakesLabel: null,
        snoozedLabel: null,
        cadence: entry.cadence,
        sortOffset: offset,
      });
    });
  }

  for (const card of input.deferredCards) {
    if (card.deferUntil === null || !isCardDeferred(card, now)) {
      continue;
    }
    items.push(snoozedItem(card, card.deferUntil, null, zone, now));
  }

  items.sort((a, b) => {
    if (a.sortOffset !== b.sortOffset) {
      return a.sortOffset - b.sortOffset;
    }
    const titleDiff = a.card.title.localeCompare(b.card.title);
    if (titleDiff !== 0) {
      return titleDiff;
    }
    return a.key.localeCompare(b.key);
  });
  return items;
}

export function groupUpcomingTimeline(
  items: readonly UpcomingTimelineItem[],
): Array<{ id: ScheduleBucketId; title: string; items: UpcomingTimelineItem[] }> {
  return SCHEDULE_BUCKETS.map((bucket) => ({
    id: bucket.id,
    title: bucket.title,
    items: items.filter((item) => item.bucket === bucket.id),
  })).filter((bucket) => bucket.items.length > 0);
}

export function buildSnoozePresets(now: Date = new Date()): SnoozePreset[] {
  return [
    { id: 'tomorrow', label: 'Tomorrow 9 AM', deferUntil: localMorning(now, 1) },
    { id: 'monday', label: 'Next Monday', deferUntil: nextMondayMorning(now) },
    { id: 'week', label: '+7 days', deferUntil: localMorning(now, 7) },
  ];
}

function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function dayOffset(iso: string, timeZone: string, now: Date, dateOnly: boolean): number {
  const todayKey = calendarDayKey(now.toISOString(), timeZone, false);
  const targetKey = calendarDayKey(iso, timeZone, dateOnly);
  return calendarDayOffset(targetKey, todayKey);
}

function snoozedItem(
  card: Card,
  deferUntil: string,
  cadence: string | null,
  timeZone: string,
  now: Date,
): UpcomingTimelineItem {
  const offset = dayOffset(deferUntil, timeZone, now, false);
  const chips = formatSnoozeChips(deferUntil, timeZone, now);
  return {
    key: `${card.id}:snoozed`,
    card,
    bucket: bucketForDayOffset(offset),
    kind: 'snoozed',
    whenIso: deferUntil,
    dateOnly: false,
    wakesLabel: chips.wakesLabel,
    snoozedLabel: chips.snoozedLabel,
    cadence,
    sortOffset: offset,
  };
}

function activeItem(entry: ScheduleCardRef, timeZone: string, now: Date): UpcomingTimelineItem {
  const whenIso = entry.card.due;
  if (whenIso === null) {
    return {
      key: `${entry.card.id}:active`,
      card: entry.card,
      bucket: 'now',
      kind: 'active',
      whenIso: null,
      dateOnly: false,
      wakesLabel: null,
      snoozedLabel: null,
      cadence: entry.cadence,
      sortOffset: 0,
    };
  }
  const dateOnly = isDateOnlyInstant(whenIso);
  const offset = dayOffset(whenIso, timeZone, now, dateOnly);
  return {
    key: `${entry.card.id}:active`,
    card: entry.card,
    bucket: bucketForDayOffset(offset),
    kind: 'active',
    whenIso,
    dateOnly,
    wakesLabel: null,
    snoozedLabel: null,
    cadence: entry.cadence,
    sortOffset: offset,
  };
}

function localMorning(now: Date, plusDays: number): string {
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + plusDays);
  next.setHours(9, 0, 0, 0);
  return next.toISOString();
}

function nextMondayMorning(now: Date): string {
  const next = new Date(now.getTime());
  const day = next.getDay();
  const delta = (8 - day) % 7 || 7;
  next.setDate(next.getDate() + delta);
  next.setHours(9, 0, 0, 0);
  return next.toISOString();
}
