import { useMemo, useRef, useState } from 'react';
import type { User } from '@agent-kanban/shared';
import { getUserInitials } from '../lib/format.js';

export interface MentionTextareaProps {
  value: string;
  onChange: (next: string) => void;
  users: readonly User[];
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
}

interface ActiveMentionToken {
  tokenStart: number;
  caretIndex: number;
  query: string;
}

const ACTIVE_MENTION_REGEX = /(?:^|[^A-Za-z0-9._%+@-])@([A-Za-z0-9_-]*)$/;

function detectActiveMention(value: string, caretIndex: number): ActiveMentionToken | null {
  const clamped = Math.max(0, Math.min(caretIndex, value.length));
  const beforeCaret = value.slice(0, clamped);
  const match = ACTIVE_MENTION_REGEX.exec(beforeCaret);
  if (!match) {
    return null;
  }
  const query = match[1] ?? '';
  const tokenStart = clamped - query.length - 1;
  if (tokenStart < 0 || value[tokenStart] !== '@') {
    return null;
  }
  return {
    tokenStart,
    caretIndex: clamped,
    query: query.toLowerCase(),
  };
}

export function MentionTextarea({
  value,
  onChange,
  users,
  ariaLabel,
  placeholder,
  rows = 2,
  disabled = false,
  className,
}: MentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caretIndex, setCaretIndex] = useState(value.length);
  const [dismissedTokenStart, setDismissedTokenStart] = useState<number | null>(null);
  const [selectionState, setSelectionState] = useState<{ queryKey: string; index: number }>({
    queryKey: '',
    index: 0,
  });

  const activeToken = useMemo(() => detectActiveMention(value, caretIndex), [value, caretIndex]);

  const suggestions = useMemo(() => {
    if (!activeToken) {
      return [];
    }
    if (activeToken.query.length === 0) {
      return [...users];
    }
    return users.filter(
      (u) =>
        u.handle.toLowerCase().includes(activeToken.query) ||
        u.displayName.toLowerCase().includes(activeToken.query),
    );
  }, [activeToken, users]);

  const isDismissed = activeToken !== null && dismissedTokenStart === activeToken.tokenStart;
  const isOpen = activeToken !== null && !isDismissed && suggestions.length > 0;
  const queryKey = activeToken ? `${activeToken.tokenStart}:${activeToken.query}` : '';
  const activeIndex =
    selectionState.queryKey === queryKey && suggestions.length > 0
      ? ((selectionState.index % suggestions.length) + suggestions.length) % suggestions.length
      : 0;

  const insertMention = (member: User) => {
    if (!activeToken) {
      return;
    }
    const inserted = `@${member.handle} `;
    const nextValue =
      value.slice(0, activeToken.tokenStart) + inserted + value.slice(activeToken.caretIndex);
    const nextCaret = activeToken.tokenStart + inserted.length;
    onChange(nextValue);
    setCaretIndex(nextCaret);
    setDismissedTokenStart(null);
    setSelectionState({ queryKey: '', index: 0 });

    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      }
    });
  };

  const syncCaretFromTarget = (target: HTMLTextAreaElement) => {
    setCaretIndex(target.selectionStart ?? target.value.length);
  };

  return (
    <div className="relative">
      {isOpen ? (
        <ul
          role="listbox"
          aria-label="Mention a household member"
          className="absolute right-0 bottom-full left-0 z-30 mb-1.5 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          {suggestions.map((member, index) => {
            const selected = index === activeIndex;
            return (
              <li key={member.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertMention(member);
                  }}
                  className={[
                    'flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition',
                    selected ? 'bg-sky-50 text-sky-900' : 'text-slate-800 hover:bg-slate-50',
                  ].join(' ')}
                >
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[11px] font-semibold text-white">
                    {getUserInitials(member.displayName)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{member.displayName}</span>
                  <span className="shrink-0 text-xs text-slate-500">@{member.handle}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        rows={rows}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          const nextValue = event.target.value;
          const nextCaret = event.target.selectionStart ?? nextValue.length;
          setCaretIndex(nextCaret);
          const nextToken = detectActiveMention(nextValue, nextCaret);
          if (!nextToken || nextToken.tokenStart !== dismissedTokenStart) {
            setDismissedTokenStart(null);
          }
          onChange(nextValue);
        }}
        onClick={(event) => syncCaretFromTarget(event.currentTarget)}
        onKeyUp={(event) => syncCaretFromTarget(event.currentTarget)}
        onSelect={(event) => syncCaretFromTarget(event.currentTarget)}
        onKeyDown={(event) => {
          if (!isOpen || !activeToken) {
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectionState({
              queryKey,
              index: (activeIndex + 1) % suggestions.length,
            });
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectionState({
              queryKey,
              index: (activeIndex - 1 + suggestions.length) % suggestions.length,
            });
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            const chosen = suggestions[activeIndex];
            if (chosen) {
              event.preventDefault();
              insertMention(chosen);
            }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDismissedTokenStart(activeToken.tokenStart);
          }
        }}
        className={
          className ??
          'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900'
        }
      />
    </div>
  );
}
