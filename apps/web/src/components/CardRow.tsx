import type { Card, User } from '@agent-kanban/shared';
import { Link } from 'react-router-dom';
import { formatDueMeta, getChecklistProgress, getUserInitials } from '../lib/format.js';

export interface CardRowProps {
  card: Card;
  usersById: ReadonlyMap<string, User>;
  showArchivedBadge?: boolean;
}

function getPriorityBadgeClasses(score: number | null): string {
  if (score === null) {
    return 'bg-slate-100 text-slate-600 border-slate-200';
  }
  if (score >= 80) {
    return 'bg-rose-50 text-rose-800 border-rose-200';
  }
  if (score >= 50) {
    return 'bg-sky-50 text-sky-800 border-sky-200';
  }
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

export function CardRow({ card, usersById, showArchivedBadge = false }: CardRowProps) {
  const dueMeta = formatDueMeta(card);
  const checklistProgress = getChecklistProgress(card);

  return (
    <li className="min-w-0">
      <Link
        to={`/cards/${card.id}`}
        className="block min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs transition hover:border-slate-300 hover:shadow-sm"
      >
        <div className="flex min-w-0 items-start justify-between gap-2.5">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold wrap-break-word text-slate-900">{card.title}</h3>
            {card.priorityReason ? (
              <p className="mt-1 line-clamp-1 text-xs text-slate-600">{card.priorityReason}</p>
            ) : null}
          </div>

          <span
            aria-label={
              card.priorityScore !== null
                ? `Priority score ${card.priorityScore}`
                : 'Unscored priority'
            }
            className={[
              'shrink-0 rounded-lg border px-2 py-0.5 text-xs font-semibold tabular-nums',
              getPriorityBadgeClasses(card.priorityScore),
            ].join(' ')}
          >
            {card.priorityScore !== null ? card.priorityScore : 'Unscored'}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
            {dueMeta !== null ? (
              <span
                className={[
                  'inline-flex items-center rounded-md px-2 py-0.5 font-medium',
                  dueMeta.isOverdue
                    ? 'bg-rose-100 text-rose-800'
                    : dueMeta.isFirm || dueMeta.isDueSoon
                      ? 'bg-amber-100 text-amber-900'
                      : 'bg-slate-100 text-slate-700',
                ].join(' ')}
              >
                {dueMeta.label}
                {dueMeta.isFirm ? ' · Firm' : ''}
              </span>
            ) : null}

            {checklistProgress.total > 0 ? (
              <span
                aria-label={`Checklist progress ${checklistProgress.checked} of ${checklistProgress.total}`}
                className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700 tabular-nums"
              >
                ☑ {checklistProgress.checked}/{checklistProgress.total}
              </span>
            ) : null}

            {card.recurrence !== null ? (
              <span
                title="Recurring card"
                aria-label="Recurring card"
                className="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 font-medium text-indigo-800"
              >
                ↻ Recurring
              </span>
            ) : null}

            {showArchivedBadge && card.archived ? (
              <span className="inline-flex items-center rounded-md bg-slate-200 px-2 py-0.5 font-medium text-slate-700">
                Archived
              </span>
            ) : null}

            {card.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-md bg-sky-50 px-2 py-0.5 font-medium text-sky-800"
              >
                #{tag}
              </span>
            ))}
          </div>

          {card.assignedUserIds.length > 0 ? (
            <div className="flex shrink-0 items-center -space-x-1">
              {card.assignedUserIds.map((userId) => {
                const member = usersById.get(userId);
                const label = member ? member.displayName : userId;
                const initials = member ? getUserInitials(member.displayName) : '??';
                return (
                  <span
                    key={userId}
                    title={label}
                    aria-label={`Assigned to ${label}`}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-white bg-slate-800 text-[10px] font-semibold text-white"
                  >
                    {initials}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
