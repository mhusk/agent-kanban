import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardStatus, Recurrence, RecurrenceUnit, User } from '@agent-kanban/shared';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AttachmentSection } from '../components/AttachmentSection.js';
import {
  addCardLink,
  addChecklistItem,
  archiveCard,
  changeCardStatus,
  completeCard,
  createCardComment,
  createChecklist,
  deleteCardLink,
  deleteChecklist,
  deleteChecklistItem,
  fetchCard,
  fetchCardActivity,
  fetchCardComments,
  fetchHouseholdUsers,
  isApiError,
  updateCard,
  updateChecklistItem,
} from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';
import { formatActorLabel, getChecklistProgress } from '../lib/format.js';

type RecurrenceKind = 'none' | 'cron' | 'interval_after_completion';

function parseTagsInput(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      tags.push(trimmed);
    }
  }
  return tags;
}

function toDueInputValue(due: string | null, dueHasTime: boolean): string {
  if (!due) {
    return '';
  }
  if (!dueHasTime) {
    return due.slice(0, 10);
  }
  const date = new Date(due);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDueInputValue(raw: string, dueHasTime: boolean): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!dueHasTime) {
    return `${trimmed.slice(0, 10)}T00:00:00.000Z`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid due date/time');
  }
  return parsed.toISOString();
}

function formatDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

export function CardDetailPage({ user }: { user: User }) {
  const { id: cardId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getAccessToken } = useAppAuth();
  const queryClient = useQueryClient();

  const cardQuery = useQuery({
    queryKey: ['card', cardId],
    queryFn: ({ signal }) => fetchCard(getAccessToken, cardId, signal),
    enabled: cardId.length > 0,
  });

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => fetchHouseholdUsers(getAccessToken, signal),
    staleTime: 60_000,
  });

  const commentsQuery = useQuery({
    queryKey: ['card-comments', cardId],
    queryFn: ({ signal }) => fetchCardComments(getAccessToken, cardId, signal),
    enabled: cardId.length > 0 && cardQuery.isSuccess,
  });

  const activityQuery = useQuery({
    queryKey: ['card-activity', cardId],
    queryFn: ({ signal }) => fetchCardActivity(getAccessToken, cardId, signal),
    enabled: cardId.length > 0 && cardQuery.isSuccess,
  });

  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const card = cardQuery.data;

  // Editable form state synced from loaded card
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [assignedUserIds, setAssignedUserIds] = useState<string[]>([]);
  const [awareUserIds, setAwareUserIds] = useState<string[]>([]);
  const [dueInput, setDueInput] = useState('');
  const [dueFirm, setDueFirm] = useState(false);
  const [dueHasTime, setDueHasTime] = useState(false);
  const [recurrenceKind, setRecurrenceKind] = useState<RecurrenceKind>('none');
  const [cronExpression, setCronExpression] = useState('0 7 * * 6');
  const [intervalEvery, setIntervalEvery] = useState(7);
  const [intervalUnit, setIntervalUnit] = useState<RecurrenceUnit>('days');
  const [recurrenceTimezone, setRecurrenceTimezone] = useState('');
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Sub-forms
  const [newChecklistTitle, setNewChecklistTitle] = useState('');
  const [itemDrafts, setItemDrafts] = useState<Record<string, string>>({});
  const [pendingItemChecks, setPendingItemChecks] = useState<Record<string, boolean>>({});
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [newLinkLabel, setNewLinkLabel] = useState('');
  const [commentText, setCommentText] = useState('');

  useEffect(() => {
    if (!card) {
      return;
    }
    setTitle(card.title);
    setDescription(card.description);
    setTagsRaw(card.tags.join(', '));
    setAssignedUserIds(card.assignedUserIds);
    setAwareUserIds(card.awareUserIds);
    setDueHasTime(card.dueHasTime);
    setDueFirm(card.dueFirm);
    setDueInput(toDueInputValue(card.due, card.dueHasTime));
    if (card.recurrence === null) {
      setRecurrenceKind('none');
      setRecurrenceTimezone('');
    } else if (card.recurrence.type === 'cron') {
      setRecurrenceKind('cron');
      setCronExpression(card.recurrence.expression);
      setRecurrenceTimezone(card.recurrence.timezone ?? '');
    } else {
      setRecurrenceKind('interval_after_completion');
      setIntervalEvery(card.recurrence.every);
      setIntervalUnit(card.recurrence.unit);
      setRecurrenceTimezone(card.recurrence.timezone ?? '');
    }
  }, [card]);

  const invalidateCardData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['card', cardId] }),
      queryClient.invalidateQueries({ queryKey: ['card-comments', cardId] }),
      queryClient.invalidateQueries({ queryKey: ['card-activity', cardId] }),
      queryClient.invalidateQueries({ queryKey: ['cards'] }),
    ]);
  };

  const handleMutationError = (err: unknown) => {
    if (isApiError(err)) {
      setActionError(err.message);
    } else if (err instanceof Error) {
      setActionError(err.message);
    } else {
      setActionError('Action failed. Please try again.');
    }
  };

  const statusMutation = useMutation({
    mutationFn: (nextStatus: CardStatus) =>
      changeCardStatus(getAccessToken, cardId, nextStatus, {
        ifUpdatedAt: card?.updatedAt,
      }),
    onSuccess: async () => {
      setActionError(null);
      await invalidateCardData();
    },
    onError: handleMutationError,
  });

  const completeMutation = useMutation({
    mutationFn: () =>
      completeCard(getAccessToken, cardId, {
        ifUpdatedAt: card?.updatedAt,
      }),
    onSuccess: async (result) => {
      setActionError(null);
      setEditMessage(
        result.recurringReset
          ? 'Completed and reset for the next occurrence.'
          : 'Marked as complete.',
      );
      await invalidateCardData();
    },
    onError: handleMutationError,
  });

  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) =>
      archiveCard(getAccessToken, cardId, archived, {
        ifUpdatedAt: card?.updatedAt,
      }),
    onSuccess: async () => {
      setActionError(null);
      await invalidateCardData();
    },
    onError: handleMutationError,
  });

  const saveCardMutation = useMutation({
    mutationFn: async () => {
      if (!card) {
        throw new Error('Card not loaded');
      }
      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        throw new Error('Title cannot be empty');
      }

      const due = fromDueInputValue(dueInput, dueHasTime);
      let recurrence: Recurrence | null = null;
      const tz = recurrenceTimezone.trim();

      if (recurrenceKind === 'cron') {
        recurrence = {
          type: 'cron',
          expression: cronExpression.trim(),
          ...(tz.length > 0 ? { timezone: tz } : {}),
        };
      } else if (recurrenceKind === 'interval_after_completion') {
        recurrence = {
          type: 'interval_after_completion',
          every: Math.max(1, Math.floor(Number(intervalEvery) || 1)),
          unit: intervalUnit,
          ...(tz.length > 0 ? { timezone: tz } : {}),
        };
      }

      return updateCard(getAccessToken, card.id, {
        title: trimmedTitle,
        description,
        tags: parseTagsInput(tagsRaw),
        assignedUserIds,
        awareUserIds,
        due,
        dueFirm: due ? dueFirm : false,
        dueHasTime: due ? dueHasTime : false,
        recurrence,
        ifUpdatedAt: card.updatedAt,
      });
    },
    onSuccess: (updatedCard) => {
      queryClient.setQueryData(['card', cardId], updatedCard);
      setActionError(null);
      setEditMessage('Changes saved.');
      void invalidateCardData();
    },
    onError: handleMutationError,
  });

  const createChecklistMutation = useMutation({
    mutationFn: (checklistTitle: string) =>
      createChecklist(getAccessToken, cardId, { title: checklistTitle }),
    onSuccess: (result) => {
      queryClient.setQueryData(['card', cardId], result.card);
      setNewChecklistTitle('');
      setActionError(null);
      void invalidateCardData();
    },
    onError: handleMutationError,
  });

  const deleteChecklistMutation = useMutation({
    mutationFn: (checklistId: string) => deleteChecklist(getAccessToken, cardId, checklistId),
    onSuccess: (result) => {
      queryClient.setQueryData(['card', cardId], result.card);
      setActionError(null);
      void invalidateCardData();
    },
    onError: handleMutationError,
  });

  const addChecklistItemMutation = useMutation({
    mutationFn: ({ checklistId, text }: { checklistId: string; text: string }) =>
      addChecklistItem(getAccessToken, cardId, checklistId, { text }),
    onSuccess: (result, variables) => {
      queryClient.setQueryData(['card', cardId], result.card);
      setItemDrafts((prev) => ({ ...prev, [variables.checklistId]: '' }));
      setActionError(null);
      void invalidateCardData();
    },
    onError: handleMutationError,
  });

  const toggleItemMutation = useMutation({
    mutationFn: ({
      checklistId,
      itemId,
      checked,
    }: {
      checklistId: string;
      itemId: string;
      checked: boolean;
    }) => updateChecklistItem(getAccessToken, cardId, checklistId, itemId, { checked }),
    onError: (err, variables) => {
      setPendingItemChecks((prev) => {
        const next = { ...prev };
        delete next[variables.itemId];
        return next;
      });
      handleMutationError(err);
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(['card', cardId], result.card);
      setPendingItemChecks((prev) => {
        const next = { ...prev };
        delete next[variables.itemId];
        return next;
      });
      setActionError(null);
      void invalidateCardData();
    },
  });

  const deleteItemMutation = useMutation({
    mutationFn: ({ checklistId, itemId }: { checklistId: string; itemId: string }) =>
      deleteChecklistItem(getAccessToken, cardId, checklistId, itemId),
    onSuccess: async () => {
      setActionError(null);
      await invalidateCardData();
    },
    onError: handleMutationError,
  });

  const addLinkMutation = useMutation({
    mutationFn: ({ url, label }: { url: string; label?: string }) =>
      addCardLink(getAccessToken, cardId, {
        url,
        ...(label ? { label } : {}),
      }),
    onSuccess: async () => {
      setNewLinkUrl('');
      setNewLinkLabel('');
      setActionError(null);
      await invalidateCardData();
    },
    onError: handleMutationError,
  });

  const deleteLinkMutation = useMutation({
    mutationFn: (linkId: string) => deleteCardLink(getAccessToken, cardId, linkId),
    onSuccess: async () => {
      setActionError(null);
      await invalidateCardData();
    },
    onError: handleMutationError,
  });

  const postCommentMutation = useMutation({
    mutationFn: (text: string) => createCardComment(getAccessToken, cardId, text),
    onSuccess: async () => {
      setCommentText('');
      setActionError(null);
      await invalidateCardData();
    },
    onError: handleMutationError,
  });

  if (cardQuery.isPending) {
    return (
      <section className="space-y-4" aria-busy="true" aria-label="Loading card details">
        <div className="h-8 w-28 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-44 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        <div className="h-64 animate-pulse rounded-2xl border border-slate-200 bg-white" />
      </section>
    );
  }

  if (cardQuery.error) {
    const isNotFound = isApiError(cardQuery.error) && cardQuery.error.status === 404;
    return (
      <section className="space-y-4">
        <Link
          to="/"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-800 hover:bg-slate-100"
        >
          ← Back
        </Link>
        <div className="rounded-2xl border border-rose-200 bg-white p-6">
          <h1 id="main-content" tabIndex={-1} className="text-lg font-semibold text-slate-900">
            {isNotFound ? 'Card not found' : 'Unable to load card'}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {isNotFound
              ? 'This card does not exist or is not shared with your account.'
              : cardQuery.error instanceof Error
                ? cardQuery.error.message
                : 'An unexpected error occurred.'}
          </p>
        </div>
      </section>
    );
  }

  if (!card) {
    return null;
  }

  const toggleUserMembership = (list: string[], userId: string): string[] =>
    list.includes(userId) ? list.filter((id) => id !== userId) : [...list, userId];

  const handleSaveCard = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setEditMessage(null);
    saveCardMutation.mutate();
  };

  const handleToggleDueHasTime = (nextHasTime: boolean) => {
    setDueHasTime(nextHasTime);
    if (!dueInput) {
      return;
    }
    if (nextHasTime && dueInput.length === 10) {
      setDueInput(`${dueInput}T09:00`);
    } else if (!nextHasTime && dueInput.length >= 10) {
      setDueInput(dueInput.slice(0, 10));
    }
  };

  const comments = commentsQuery.data ?? [];
  const activity = activityQuery.data?.activity ?? [];
  const checklistProgress = getChecklistProgress(card);

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            if (window.history.length > 1) {
              navigate(-1);
            } else {
              navigate('/');
            }
          }}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-800 hover:bg-slate-100"
        >
          ← Back
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {card.priorityScore !== null ? (
            <span className="rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-900 tabular-nums">
              Priority {card.priorityScore}
            </span>
          ) : (
            <span className="rounded-lg border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              Unscored
            </span>
          )}
          {card.archived ? (
            <span className="rounded-lg bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
              Archived
            </span>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <p
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          {actionError}
        </p>
      ) : null}

      {editMessage ? (
        <p
          role="status"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          {editMessage}
        </p>
      ) : null}

      {/* Status pills + Primary Complete & Archive actions */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <h1
          id="main-content"
          tabIndex={-1}
          className="text-xl font-semibold wrap-break-word text-slate-900"
        >
          {card.title}
        </h1>
        {card.priorityReason ? (
          <p className="mt-1 text-xs text-slate-600">{card.priorityReason}</p>
        ) : null}

        <div
          className="mt-4 flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Card status"
        >
          {(['todo', 'doing', 'blocked'] as const).map((statusOption) => {
            const label =
              statusOption === 'todo' ? 'To-Do' : statusOption === 'doing' ? 'Doing' : 'Blocked';
            const active = card.status === statusOption;
            return (
              <button
                key={statusOption}
                type="button"
                aria-pressed={active}
                disabled={statusMutation.isPending}
                onClick={() => statusMutation.mutate(statusOption)}
                className={[
                  'min-h-11 rounded-xl px-4 py-2 text-xs font-semibold transition',
                  active
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-100',
                ].join(' ')}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-slate-100 pt-3">
          {card.recurrence === null && card.status === 'done' ? (
            <button
              type="button"
              disabled={statusMutation.isPending}
              onClick={() => statusMutation.mutate('todo')}
              className="min-h-11 rounded-xl bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-60"
            >
              Reopen to To-Do
            </button>
          ) : (
            <button
              type="button"
              disabled={completeMutation.isPending}
              onClick={() => completeMutation.mutate()}
              className="min-h-11 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
            >
              {card.recurrence !== null ? 'Complete & Reset' : 'Complete'}
            </button>
          )}

          <button
            type="button"
            disabled={archiveMutation.isPending}
            onClick={() => archiveMutation.mutate(!card.archived)}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-60"
          >
            {card.archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      </div>

      {/* Editable details */}
      <form
        onSubmit={handleSaveCard}
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"
      >
        <h2 className="text-sm font-semibold tracking-wide text-slate-600 uppercase">Details</h2>

        <div>
          <label htmlFor="detail-title" className="block text-xs font-semibold text-slate-700">
            Title
          </label>
          <input
            id="detail-title"
            type="text"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
          />
        </div>

        <div>
          <label
            htmlFor="detail-description"
            className="block text-xs font-semibold text-slate-700"
          >
            Description
          </label>
          <textarea
            id="detail-description"
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          />
        </div>

        <div>
          <label htmlFor="detail-tags" className="block text-xs font-semibold text-slate-700">
            Tags (comma-separated)
          </label>
          <input
            id="detail-tags"
            type="text"
            value={tagsRaw}
            onChange={(event) => setTagsRaw(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <fieldset className="rounded-xl border border-slate-200 p-3">
            <legend className="px-1 text-xs font-semibold text-slate-700">Assigned to</legend>
            <div className="mt-1 space-y-1">
              {users.map((member) => (
                <label
                  key={member.id}
                  className="flex min-h-10 cursor-pointer items-center gap-2 text-xs text-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={assignedUserIds.includes(member.id)}
                    onChange={() =>
                      setAssignedUserIds((prev) => toggleUserMembership(prev, member.id))
                    }
                    className="h-4 w-4 rounded border-slate-300 text-sky-600"
                  />
                  <span>
                    {member.displayName} (@{member.handle})
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="rounded-xl border border-slate-200 p-3">
            <legend className="px-1 text-xs font-semibold text-slate-700">Aware viewers</legend>
            <div className="mt-1 space-y-1">
              {users.map((member) => (
                <label
                  key={member.id}
                  className="flex min-h-10 cursor-pointer items-center gap-2 text-xs text-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={awareUserIds.includes(member.id)}
                    onChange={() =>
                      setAwareUserIds((prev) => toggleUserMembership(prev, member.id))
                    }
                    className="h-4 w-4 rounded border-slate-300 text-sky-600"
                  />
                  <span>
                    {member.displayName} (@{member.handle})
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="space-y-2">
          <label htmlFor="detail-due" className="block text-xs font-semibold text-slate-700">
            Due date
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="detail-due"
              type={dueHasTime ? 'datetime-local' : 'date'}
              value={dueInput}
              onChange={(event) => setDueInput(event.target.value)}
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
            />
            {dueInput ? (
              <button
                type="button"
                onClick={() => setDueInput('')}
                className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Clear
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-xs font-medium text-slate-800">
              <input
                type="checkbox"
                checked={dueFirm}
                onChange={(event) => setDueFirm(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-sky-600"
              />
              Firm deadline
            </label>
            <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-xs font-medium text-slate-800">
              <input
                type="checkbox"
                checked={dueHasTime}
                onChange={(event) => handleToggleDueHasTime(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-sky-600"
              />
              Include time
            </label>
          </div>
        </div>

        <div className="space-y-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <label htmlFor="detail-recurrence" className="block text-xs font-semibold text-slate-700">
            Recurrence
          </label>
          <select
            id="detail-recurrence"
            value={recurrenceKind}
            onChange={(event) => setRecurrenceKind(event.target.value as RecurrenceKind)}
            className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
          >
            <option value="none">None</option>
            <option value="cron">Weekly / Cron</option>
            <option value="interval_after_completion">Every N days/weeks/months after done</option>
          </select>

          {recurrenceKind === 'cron' ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="detail-cron-expr" className="block text-xs text-slate-600">
                  5-field cron expression
                </label>
                <input
                  id="detail-cron-expr"
                  type="text"
                  value={cronExpression}
                  onChange={(event) => setCronExpression(event.target.value)}
                  placeholder="0 7 * * 6"
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="detail-recurrence-tz" className="block text-xs text-slate-600">
                  Timezone (optional IANA)
                </label>
                <input
                  id="detail-recurrence-tz"
                  type="text"
                  value={recurrenceTimezone}
                  onChange={(event) => setRecurrenceTimezone(event.target.value)}
                  placeholder="UTC"
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                />
              </div>
            </div>
          ) : null}

          {recurrenceKind === 'interval_after_completion' ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div>
                <label htmlFor="detail-interval-every" className="block text-xs text-slate-600">
                  Every
                </label>
                <input
                  id="detail-interval-every"
                  type="number"
                  min={1}
                  max={3650}
                  value={intervalEvery}
                  onChange={(event) => setIntervalEvery(Number(event.target.value))}
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="detail-interval-unit" className="block text-xs text-slate-600">
                  Unit
                </label>
                <select
                  id="detail-interval-unit"
                  value={intervalUnit}
                  onChange={(event) => setIntervalUnit(event.target.value as RecurrenceUnit)}
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                >
                  <option value="days">days</option>
                  <option value="weeks">weeks</option>
                  <option value="months">months</option>
                </select>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="detail-interval-tz" className="block text-xs text-slate-600">
                  Timezone
                </label>
                <input
                  id="detail-interval-tz"
                  type="text"
                  value={recurrenceTimezone}
                  onChange={(event) => setRecurrenceTimezone(event.target.value)}
                  placeholder="UTC"
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saveCardMutation.isPending}
            className="min-h-11 rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {saveCardMutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      {/* Checklists */}
      <section
        aria-labelledby="checklists-heading"
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"
      >
        <div className="flex items-center justify-between">
          <h2
            id="checklists-heading"
            className="text-sm font-semibold tracking-wide text-slate-600 uppercase"
          >
            Checklists
            {checklistProgress.total > 0
              ? ` (${checklistProgress.checked}/${checklistProgress.total})`
              : ''}
          </h2>
        </div>

        {card.checklists.map((checklist) => {
          const checkedCount = checklist.items.filter((i) => i.checked).length;
          const draft = itemDrafts[checklist.id] ?? '';
          return (
            <div key={checklist.id} className="space-y-2.5 rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  {checklist.title}{' '}
                  <span className="text-xs font-normal text-slate-500 tabular-nums">
                    ({checkedCount}/{checklist.items.length})
                  </span>
                </h3>
                <button
                  type="button"
                  onClick={() => deleteChecklistMutation.mutate(checklist.id)}
                  className="min-h-9 rounded-lg px-2.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                >
                  Delete checklist
                </button>
              </div>

              <ul className="space-y-1">
                {checklist.items.map((item) => {
                  const isChecked = pendingItemChecks[item.id] ?? item.checked;
                  return (
                    <li key={item.id} className="flex items-center justify-between gap-2">
                      <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(event) => {
                            const nextChecked = event.target.checked;
                            setPendingItemChecks((prev) => ({
                              ...prev,
                              [item.id]: nextChecked,
                            }));
                            toggleItemMutation.mutate({
                              checklistId: checklist.id,
                              itemId: item.id,
                              checked: nextChecked,
                            });
                          }}
                          className="h-4 w-4 shrink-0 rounded border-slate-300 text-sky-600"
                        />
                        <span
                          className={isChecked ? 'text-slate-400 line-through' : 'text-slate-800'}
                        >
                          {item.text}
                        </span>
                      </label>
                      <button
                        type="button"
                        aria-label={`Delete item ${item.text}`}
                        onClick={() =>
                          deleteItemMutation.mutate({
                            checklistId: checklist.id,
                            itemId: item.id,
                          })
                        }
                        className="min-h-11 shrink-0 rounded-lg px-2.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-rose-700"
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const trimmed = draft.trim();
                  if (trimmed) {
                    addChecklistItemMutation.mutate({ checklistId: checklist.id, text: trimmed });
                  }
                }}
                className="flex gap-2 pt-1"
              >
                <input
                  type="text"
                  aria-label={`Add item to ${checklist.title}`}
                  placeholder="Add checklist item…"
                  value={draft}
                  onChange={(event) =>
                    setItemDrafts((prev) => ({ ...prev, [checklist.id]: event.target.value }))
                  }
                  className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm"
                />
                <button
                  type="submit"
                  disabled={addChecklistItemMutation.isPending}
                  className="min-h-11 shrink-0 rounded-xl border border-slate-300 bg-white px-3.5 text-xs font-semibold text-slate-800 hover:bg-slate-100"
                >
                  Add
                </button>
              </form>
            </div>
          );
        })}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = newChecklistTitle.trim();
            if (trimmed) {
              createChecklistMutation.mutate(trimmed);
            }
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            aria-label="New checklist title"
            placeholder="New checklist title…"
            value={newChecklistTitle}
            onChange={(event) => setNewChecklistTitle(event.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm"
          />
          <button
            type="submit"
            disabled={createChecklistMutation.isPending}
            className="min-h-11 shrink-0 rounded-xl bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Add checklist
          </button>
        </form>
      </section>

      {/* Links */}
      <section
        aria-labelledby="links-heading"
        className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"
      >
        <h2
          id="links-heading"
          className="text-sm font-semibold tracking-wide text-slate-600 uppercase"
        >
          Links ({card.links.length})
        </h2>

        {card.links.length > 0 ? (
          <ul className="space-y-2">
            {card.links.map((link) => (
              <li
                key={link.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2"
              >
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm font-medium text-sky-700 underline"
                >
                  {link.label ?? link.url}
                </a>
                <button
                  type="button"
                  aria-label={`Remove link ${link.label ?? link.url}`}
                  onClick={() => deleteLinkMutation.mutate(link.id)}
                  className="min-h-9 shrink-0 rounded-lg px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-rose-700"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const url = newLinkUrl.trim();
            if (url) {
              addLinkMutation.mutate({
                url,
                label: newLinkLabel.trim() || undefined,
              });
            }
          }}
          className="grid grid-cols-1 gap-2 sm:grid-cols-3"
        >
          <input
            type="url"
            aria-label="Link URL"
            placeholder="https://example.test/…"
            value={newLinkUrl}
            onChange={(event) => setNewLinkUrl(event.target.value)}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm sm:col-span-2"
          />
          <input
            type="text"
            aria-label="Link label"
            placeholder="Optional label"
            value={newLinkLabel}
            onChange={(event) => setNewLinkLabel(event.target.value)}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm"
          />
          <div className="sm:col-span-3 sm:flex sm:justify-end">
            <button
              type="submit"
              disabled={addLinkMutation.isPending}
              className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 hover:bg-slate-100 sm:w-auto"
            >
              Add link
            </button>
          </div>
        </form>
      </section>

      {/* Photo & PDF Attachments */}
      <AttachmentSection cardId={card.id} />

      {/* Comments */}
      <section
        aria-labelledby="comments-heading"
        className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"
      >
        <h2
          id="comments-heading"
          className="text-sm font-semibold tracking-wide text-slate-600 uppercase"
        >
          Comments ({comments.length})
        </h2>

        {comments.length > 0 ? (
          <ul className="space-y-2.5">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className="rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-900">
                    {formatActorLabel(comment, usersById)}
                  </span>
                  <span className="text-slate-500">{formatDateTime(comment.createdAt)}</span>
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap wrap-break-word text-slate-800">
                  {comment.text}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">No comments yet.</p>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = commentText.trim();
            if (trimmed) {
              postCommentMutation.mutate(trimmed);
            }
          }}
          className="space-y-2 pt-1"
        >
          <textarea
            aria-label="Add a comment"
            rows={2}
            value={commentText}
            onChange={(event) => setCommentText(event.target.value)}
            placeholder={`Write a comment… use @handle to mention (signed in as @${user.handle})`}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={postCommentMutation.isPending}
              className="min-h-11 rounded-xl bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {postCommentMutation.isPending ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </form>
      </section>

      {/* Collapsible Activity Log (native <details> without heading inside <summary>) */}
      <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <summary className="cursor-pointer list-none text-sm font-semibold text-slate-800">
          Activity Log ({activity.length})
        </summary>
        {activity.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">No activity recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-2 border-t border-slate-100 pt-3">
            {activity.map((entry) => {
              const diffKeys = Object.keys(entry.diff);
              return (
                <li key={entry.id} className="text-xs text-slate-700">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <strong className="font-semibold text-slate-900">
                        {formatActorLabel(entry, usersById)}
                      </strong>{' '}
                      · <code className="rounded bg-slate-100 px-1 py-0.5">{entry.action}</code>
                    </span>
                    <span className="text-slate-500">{formatDateTime(entry.createdAt)}</span>
                  </div>
                  {entry.note ? <p className="mt-0.5 text-slate-600">Note: {entry.note}</p> : null}
                  {diffKeys.length > 0 ? (
                    <p className="mt-0.5 text-slate-500">Changed: {diffKeys.join(', ')}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </details>
    </section>
  );
}
