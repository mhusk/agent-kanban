import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { User } from '@agent-kanban/shared';
import { invalidateCardsAndTags } from '../hooks/useFilteredCards.js';
import { createCard, isApiError } from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';
import { TagPicker } from './TagPicker.js';

export interface QuickAddModalProps {
  open: boolean;
  onClose: () => void;
  currentUser: User;
  users: readonly User[];
}

function toUtcIsoFromDueInput(rawValue: string, hasTime: boolean): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }
  if (!hasTime) {
    return `${trimmed.slice(0, 10)}T00:00:00.000Z`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid due date and time');
  }
  return parsed.toISOString();
}

export function QuickAddModal({ open, onClose, currentUser, users }: QuickAddModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { getAccessToken } = useAppAuth();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [dueInput, setDueInput] = useState('');
  const [dueFirm, setDueFirm] = useState(false);
  const [dueHasTime, setDueHasTime] = useState(false);
  const [shareWithHousehold, setShareWithHousehold] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setTags([]);
    setDueInput('');
    setDueFirm(false);
    setDueHasTime(false);
    setShareWithHousehold(true);
    setFormError(null);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
      titleInputRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Fallback light-dismiss for browsers without native `closedby="any"` (e.g., Safari)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || 'closedBy' in HTMLDialogElement.prototype) {
      return;
    }

    const isOutside = (event: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };

    let pressedOutside = false;
    const onPointerDown = (event: PointerEvent) => {
      pressedOutside = isOutside(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pressedOutside && isOutside(event)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const createMutation = useMutation({
    mutationFn: async () => {
      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        throw new Error('Title is required');
      }

      const due = toUtcIsoFromDueInput(dueInput, dueHasTime);
      const awareUserIds = shareWithHousehold
        ? users.filter((u) => u.id !== currentUser.id).map((u) => u.id)
        : [];

      const idempotencyKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `qa-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      return createCard(
        getAccessToken,
        {
          title: trimmedTitle,
          description: description.trim(),
          tags,
          assignedUserIds: [currentUser.id],
          awareUserIds,
          due,
          dueFirm: due ? dueFirm : false,
          dueHasTime: due ? dueHasTime : false,
        },
        idempotencyKey,
      );
    },
    onSuccess: async () => {
      await invalidateCardsAndTags(queryClient);
      resetForm();
      onClose();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFormError(error.message);
      } else if (error instanceof Error) {
        setFormError(error.message);
      } else {
        setFormError('Unable to create card');
      }
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    createMutation.mutate();
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

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="quick-add-title"
      onClose={() => {
        if (dialogRef.current) {
          dialogRef.current.returnValue = '';
        }
        onClose();
      }}
      {...({ closedby: 'any' } as Record<string, unknown>)}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl"
    >
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h1 id="quick-add-title" className="text-lg font-semibold text-slate-900">
            New card
          </h1>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close new card modal"
            className="min-h-11 min-w-11 rounded-xl border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Close
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {formError ? (
            <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {formError}
            </p>
          ) : null}

          <div>
            <label
              htmlFor="quick-add-title-input"
              className="block text-xs font-semibold text-slate-700"
            >
              Title
            </label>
            <input
              ref={titleInputRef}
              id="quick-add-title-input"
              type="text"
              required
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs to get done?"
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
            />
          </div>

          <div>
            <label
              htmlFor="quick-add-description"
              className="block text-xs font-semibold text-slate-700"
            >
              Description
            </label>
            <textarea
              id="quick-add-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional details or context…"
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
          </div>

          <TagPicker id="quick-add-tags" value={tags} onChange={setTags} />

          <div className="space-y-2">
            <label htmlFor="quick-add-due" className="block text-xs font-semibold text-slate-700">
              Due date (optional)
            </label>
            <input
              id="quick-add-due"
              type={dueHasTime ? 'datetime-local' : 'date'}
              value={dueInput}
              onChange={(event) => setDueInput(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
            />
            <div className="flex flex-wrap gap-4 pt-1">
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium text-slate-800">
                <input
                  type="checkbox"
                  checked={dueFirm}
                  onChange={(event) => setDueFirm(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-sky-600"
                />
                Firm deadline
              </label>

              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium text-slate-800">
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

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-900">
              <input
                type="checkbox"
                checked={shareWithHousehold}
                onChange={(event) => setShareWithHousehold(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-sky-600"
              />
              <span>Share with household</span>
            </label>
            <p className="pl-6.5 text-xs text-slate-600">
              Adds other household members as aware viewers so shared cards and agents stay in sync.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="min-h-11 rounded-xl bg-sky-700 px-5 py-2 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:opacity-60"
            >
              {createMutation.isPending ? 'Creating…' : 'Create card'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
