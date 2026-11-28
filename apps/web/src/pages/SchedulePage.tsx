import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isCardDeferred, type Card } from '@agent-kanban/shared';
import { Link } from 'react-router-dom';
import { invalidateCardsAndTags } from '../hooks/useFilteredCards.js';
import {
  completeCard,
  fetchRecurringSchedule,
  updateCardDeferUntil,
  type RecurringSchedule,
  type RecurringScheduleEntry,
} from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';
import {
  buildUpcomingTimeline,
  formatLastCompletedSummary,
  formatLeadDaysSummary,
  formatScheduleInstant,
  groupUpcomingTimeline,
  type UpcomingTimelineItem,
} from '../lib/scheduleUi.js';

type ScheduleMode = 'upcoming' | 'all';

const HORIZON_DAYS = 60;

export function SchedulePage() {
  const { getAccessToken } = useAppAuth();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ScheduleMode>('upcoming');
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const scheduleQuery = useQuery({
    queryKey: ['schedule', HORIZON_DAYS],
    queryFn: ({ signal }) => fetchRecurringSchedule(getAccessToken, HORIZON_DAYS, signal),
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['schedule'] }),
      invalidateCardsAndTags(queryClient),
    ]);
  };

  const wakeMutation = useMutation({
    mutationFn: (card: Card) => updateCardDeferUntil(getAccessToken, card.id, null, card.updatedAt),
    onSuccess: async (card) => {
      setActionError(null);
      setMessage(`Woke "${card.title}". It is back on To-Do.`);
      await refresh();
    },
    onError: (err: unknown) => {
      setMessage(null);
      setActionError(err instanceof Error ? err.message : 'Unable to wake this card.');
    },
  });

  const completeMutation = useMutation({
    mutationFn: (card: Card) =>
      completeCard(getAccessToken, card.id, { ifUpdatedAt: card.updatedAt }),
    onSuccess: async (result) => {
      setActionError(null);
      setMessage(
        result.recurringReset
          ? `Completed "${result.card.title}" and reset the next occurrence.`
          : `Completed "${result.card.title}".`,
      );
      await refresh();
    },
    onError: (err: unknown) => {
      setMessage(null);
      setActionError(err instanceof Error ? err.message : 'Unable to complete this card.');
    },
  });

  const schedule = scheduleQuery.data;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 id="main-content" tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          Schedule
        </h1>
        {schedule ? (
          <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-700 tabular-nums">
            {schedule.recurring.length}
          </span>
        ) : null}
      </div>

      <div
        role="group"
        aria-label="Schedule view"
        className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-200 p-1"
      >
        <ModeButton
          pressed={mode === 'upcoming'}
          onClick={() => setMode('upcoming')}
          label="Upcoming"
        />
        <ModeButton pressed={mode === 'all'} onClick={() => setMode('all')} label="All Recurring" />
      </div>

      {message ? (
        <p
          role="status"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          {message}
        </p>
      ) : null}

      {actionError ? (
        <p
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          {actionError}
        </p>
      ) : null}

      {scheduleQuery.isLoading ? (
        <div className="space-y-2.5" aria-busy="true" aria-label="Loading schedule">
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white" />
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        </div>
      ) : scheduleQuery.error ? (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-white p-4 text-sm">
          <p className="font-medium text-rose-800">
            {scheduleQuery.error instanceof Error
              ? scheduleQuery.error.message
              : 'Unable to load the schedule.'}
          </p>
          <button
            type="button"
            onClick={() => {
              void scheduleQuery.refetch();
            }}
            className="mt-3 min-h-11 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Retry
          </button>
        </div>
      ) : schedule ? (
        mode === 'upcoming' ? (
          <UpcomingTimeline
            schedule={schedule}
            wakingCardId={wakeMutation.isPending ? (wakeMutation.variables?.id ?? null) : null}
            onWake={(card) => wakeMutation.mutate(card)}
          />
        ) : (
          <AllRecurringList
            schedule={schedule}
            wakingCardId={wakeMutation.isPending ? (wakeMutation.variables?.id ?? null) : null}
            completingCardId={
              completeMutation.isPending ? (completeMutation.variables?.id ?? null) : null
            }
            onWake={(card) => wakeMutation.mutate(card)}
            onComplete={(card) => completeMutation.mutate(card)}
          />
        )
      ) : null}
    </section>
  );
}

function ModeButton({
  pressed,
  onClick,
  label,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={[
        'min-h-11 rounded-xl px-3 text-sm font-semibold transition',
        pressed ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function UpcomingTimeline({
  schedule,
  wakingCardId,
  onWake,
}: {
  schedule: RecurringSchedule;
  wakingCardId: string | null;
  onWake: (card: Card) => void;
}) {
  const groups = groupUpcomingTimeline(
    buildUpcomingTimeline(schedule, new Date(schedule.generatedAt)),
  );

  if (groups.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
        Nothing upcoming. Recurring cards and snoozed tasks will show up here.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`schedule-${group.id}`} className="space-y-2.5">
          <h2 id={`schedule-${group.id}`} className="text-sm font-semibold text-slate-700">
            {group.title}
          </h2>
          <ul className="space-y-2.5">
            {group.items.map((item) => (
              <TimelineRow
                key={item.key}
                item={item}
                timeZone={schedule.timezone}
                waking={wakingCardId === item.card.id}
                onWake={onWake}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TimelineRow({
  item,
  timeZone,
  waking,
  onWake,
}: {
  item: UpcomingTimelineItem;
  timeZone: string;
  waking: boolean;
  onWake: (card: Card) => void;
}) {
  const whenLabel =
    item.kind === 'occurrence'
      ? `Projected ${formatScheduleInstant(item.whenIso, timeZone, item.dateOnly)}`
      : item.kind === 'snoozed'
        ? `Wakes ${formatScheduleInstant(item.whenIso, timeZone, false)}`
        : formatScheduleInstant(item.whenIso, timeZone, item.dateOnly);

  return (
    <li className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <Link
          to={`/cards/${item.card.id}`}
          className="min-w-0 flex-1 text-sm font-semibold wrap-break-word text-slate-900 hover:text-sky-800"
        >
          {item.card.title}
        </Link>
        {item.kind === 'occurrence' ? (
          <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
            Upcoming
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-slate-600">{whenLabel}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        {item.wakesLabel ? (
          <span className="inline-flex items-center rounded-md bg-sky-50 px-2 py-0.5 font-medium text-sky-800">
            {item.wakesLabel}
          </span>
        ) : null}
        {item.snoozedLabel ? (
          <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 font-medium text-amber-900">
            {item.snoozedLabel}
          </span>
        ) : null}
        {item.cadence ? <span className="font-medium text-slate-500">{item.cadence}</span> : null}
      </div>
      {item.kind === 'snoozed' ? (
        <div className="mt-3">
          <button
            type="button"
            disabled={waking}
            onClick={() => onWake(item.card)}
            className="min-h-11 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {waking ? 'Waking…' : 'Wake now'}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function AllRecurringList({
  schedule,
  wakingCardId,
  completingCardId,
  onWake,
  onComplete,
}: {
  schedule: RecurringSchedule;
  wakingCardId: string | null;
  completingCardId: string | null;
  onWake: (card: Card) => void;
  onComplete: (card: Card) => void;
}) {
  if (schedule.recurring.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
        No recurring cards yet.
      </p>
    );
  }

  const now = new Date(schedule.generatedAt);

  return (
    <ul className="space-y-2.5">
      {schedule.recurring.map((entry) => (
        <RecurringMasterRow
          key={entry.card.id}
          entry={entry}
          timeZone={schedule.timezone}
          now={now}
          waking={wakingCardId === entry.card.id}
          completing={completingCardId === entry.card.id}
          onWake={onWake}
          onComplete={onComplete}
        />
      ))}
    </ul>
  );
}

function RecurringMasterRow({
  entry,
  timeZone,
  now,
  waking,
  completing,
  onWake,
  onComplete,
}: {
  entry: RecurringScheduleEntry;
  timeZone: string;
  now: Date;
  waking: boolean;
  completing: boolean;
  onWake: (card: Card) => void;
  onComplete: (card: Card) => void;
}) {
  const nextDue = entry.card.due ?? entry.nextOccurrences[0] ?? null;
  const deferred = isCardDeferred(entry.card, now);

  return (
    <li className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
      <Link
        to={`/cards/${entry.card.id}`}
        className="text-sm font-semibold wrap-break-word text-slate-900 hover:text-sky-800"
      >
        {entry.card.title}
      </Link>
      <dl className="mt-2 space-y-1 text-xs text-slate-600">
        <div>
          <dt className="sr-only">Cadence</dt>
          <dd className="font-medium text-slate-800">{entry.cadence}</dd>
        </div>
        <div>
          <dt className="sr-only">Completion</dt>
          <dd>{formatLastCompletedSummary(entry.card.lastCompletedAt, timeZone)}</dd>
        </div>
        <div>
          <dt className="inline">Next due: </dt>
          <dd className="inline">{formatScheduleInstant(nextDue, timeZone)}</dd>
        </div>
        <div>
          <dt className="sr-only">Wake-up</dt>
          <dd>
            {formatLeadDaysSummary(entry.effectiveLeadDays, entry.card.recurrence?.autoDefer)}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={completing}
          onClick={() => onComplete(entry.card)}
          className="min-h-11 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {completing ? 'Completing…' : 'Complete & Reset'}
        </button>
        {deferred ? (
          <button
            type="button"
            disabled={waking}
            onClick={() => onWake(entry.card)}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-60"
          >
            {waking ? 'Waking…' : 'Wake now'}
          </button>
        ) : null}
      </div>
    </li>
  );
}
