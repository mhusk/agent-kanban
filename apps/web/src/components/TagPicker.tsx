import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { normalizeTag } from '@agent-kanban/shared';
import { fetchTags } from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';
import {
  TAGS_QUERY_KEY,
  buildTagPickerOptions,
  commitTag,
  commitTagParts,
  exactTagOptionIndex,
  normalizeTagList,
  removeLastTag,
  removeTag,
  resolveTagKeyAction,
  splitTagEntry,
  tagQueryFromDraft,
  topUnusedTags,
  type TagKeyAction,
  type TagPickerOption,
} from '../lib/tagPicker.js';

export interface TagPickerProps {
  id: string;
  label?: string;
  value: readonly string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

function keepInputFocused(event: PointerEvent<HTMLElement>): void {
  event.preventDefault();
}

export function TagPicker({
  id,
  label = 'Tags',
  value,
  onChange,
  disabled = false,
}: TagPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { getAccessToken } = useAppAuth();
  const tagsQuery = useQuery({
    queryKey: TAGS_QUERY_KEY,
    queryFn: ({ signal }) => fetchTags(getAccessToken, signal),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });

  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [highlightDraft, setHighlightDraft] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const vocabulary = tagsQuery.data ?? [];
  const normalizedValue = useMemo(() => normalizeTagList(value), [value]);
  const options = useMemo(
    () => buildTagPickerOptions(vocabulary, normalizedValue, draft),
    [vocabulary, normalizedValue, draft],
  );
  const suggestions = useMemo(
    () => topUnusedTags(vocabulary, normalizedValue),
    [vocabulary, normalizedValue],
  );

  const activeIndex = highlightDraft === draft ? highlight : -1;
  const safeActiveIndex = activeIndex >= 0 && activeIndex < options.length ? activeIndex : -1;
  const dropdownOpen = menuOpen && options.length > 0 && !disabled;
  const listboxId = `${id}-suggestions`;

  const applyCommit = (
    result: { tags: string[]; error: string | null; changed: boolean },
    nextDraft: string,
  ) => {
    setInputError(result.error);
    if (result.changed) {
      onChange(result.tags);
    }
    setDraft(nextDraft);
    setHighlight(-1);
    setHighlightDraft(nextDraft);
    setMenuOpen(tagQueryFromDraft(nextDraft).length > 0);
  };

  const commitOption = (option: TagPickerOption | undefined) => {
    if (!option) {
      return;
    }
    applyCommit(commitTag(normalizedValue, option.tag), '');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      return;
    }

    const action: TagKeyAction = resolveTagKeyAction({
      key: event.key,
      draft,
      suggestionCount: options.length,
      activeIndex: dropdownOpen ? safeActiveIndex : -1,
      exactIndex: exactTagOptionIndex(options, draft),
      hasTags: normalizedValue.length > 0,
    });

    switch (action.type) {
      case 'move':
        event.preventDefault();
        setMenuOpen(true);
        setHighlight(action.nextIndex);
        setHighlightDraft(draft);
        return;
      case 'commit-suggestion':
        event.preventDefault();
        commitOption(options[action.index]);
        return;
      case 'commit-draft':
        event.preventDefault();
        applyCommit(commitTag(normalizedValue, draft), '');
        return;
      case 'remove-last':
        event.preventDefault();
        onChange(removeLastTag(normalizedValue));
        setInputError(null);
        return;
      case 'none':
        return;
      default: {
        const unreachable: never = action;
        return unreachable;
      }
    }
  };

  return (
    <div ref={rootRef} className="min-w-0">
      <label htmlFor={id} className="block text-xs font-semibold text-slate-700">
        {label}
      </label>
      <div className="relative mt-1 min-w-0">
        <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-2 py-1.5 focus-within:border-sky-600">
          {normalizedValue.map((tag) => (
            <span
              key={tag}
              className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-full bg-sky-50 py-0.5 pr-0.5 pl-2 text-xs font-medium text-sky-900"
            >
              <span className="min-w-0 break-all">#{tag}</span>
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                disabled={disabled}
                onClick={() => {
                  onChange(removeTag(normalizedValue, tag));
                  setInputError(null);
                }}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm text-sky-800 hover:bg-sky-100 disabled:opacity-60"
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ))}
          <input
            id={id}
            role="combobox"
            type="text"
            value={draft}
            disabled={disabled}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            aria-expanded={dropdownOpen}
            aria-controls={dropdownOpen ? listboxId : undefined}
            aria-activedescendant={
              dropdownOpen && safeActiveIndex >= 0 ? `${id}-option-${safeActiveIndex}` : undefined
            }
            placeholder={normalizedValue.length === 0 ? 'Add a tag' : ''}
            onChange={(event) => {
              const raw = event.target.value;
              const { completed, remainder } = splitTagEntry(raw);
              if (completed.length > 0) {
                applyCommit(commitTagParts(normalizedValue, completed), remainder);
                return;
              }
              setDraft(raw);
              setInputError(null);
              setMenuOpen(true);
            }}
            onFocus={() => {
              setMenuOpen(true);
            }}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && rootRef.current?.contains(next)) {
                return;
              }
              setMenuOpen(false);
            }}
            onKeyDown={handleKeyDown}
            className="min-h-9 min-w-32 flex-1 bg-transparent px-1 text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
        </div>

        {dropdownOpen ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Tag suggestions"
            className="absolute top-full right-0 left-0 z-30 mt-1 max-h-60 overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
          >
            {options.map((option, index) => (
              <li key={`${option.kind}-${option.tag}`} role="presentation">
                <button
                  type="button"
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={index === safeActiveIndex}
                  onPointerDown={keepInputFocused}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    commitOption(option);
                  }}
                  className={[
                    'flex min-h-11 w-full min-w-0 items-center justify-between gap-2 px-3 text-left text-sm',
                    index === safeActiveIndex
                      ? 'bg-sky-50 text-sky-950'
                      : 'text-slate-800 hover:bg-slate-50',
                  ].join(' ')}
                >
                  <span className="min-w-0 flex-1 break-all">
                    {option.kind === 'create' ? `Create #${option.tag}` : `#${option.tag}`}
                  </span>
                  {option.kind === 'existing' ? (
                    <span className="shrink-0 text-xs text-slate-500 tabular-nums">
                      {option.openCount} open
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {inputError ? (
        <p role="alert" className="mt-1 text-xs text-rose-700">
          {inputError}
        </p>
      ) : null}

      {suggestions.length > 0 && !dropdownOpen ? (
        <div
          role="group"
          aria-label="Suggested tags"
          className="mt-2 flex min-w-0 flex-wrap gap-1.5"
        >
          {suggestions.map((item) => {
            const tag = normalizeTag(item.tag);
            return (
              <button
                key={tag}
                type="button"
                disabled={disabled}
                aria-label={`Add suggested tag ${tag}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  applyCommit(commitTag(normalizedValue, tag), '');
                }}
                className="max-w-full min-h-9 rounded-full border border-slate-300 bg-white px-3 text-xs font-medium break-all text-slate-800 hover:bg-slate-50 disabled:opacity-60"
              >
                #{tag}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
