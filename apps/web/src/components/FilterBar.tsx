import type { User } from '@agent-kanban/shared';
import type { PersonFilterValue } from '../hooks/useFilteredCards.js';

export interface FilterBarProps {
  searchText: string;
  onSearchChange: (value: string) => void;
  selectedTag: string | null;
  onTagChange: (value: string | null) => void;
  availableTags: readonly string[];
  personFilter: PersonFilterValue;
  onPersonFilterChange: (value: PersonFilterValue) => void;
  users: readonly User[];
  currentUserId: string;
}

export function FilterBar({
  searchText,
  onSearchChange,
  selectedTag,
  onTagChange,
  availableTags,
  personFilter,
  onPersonFilterChange,
  users,
  currentUserId,
}: FilterBarProps) {
  return (
    <div className="sticky top-[69px] z-10 -mx-4 border-b border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <input
            type="search"
            aria-label="Search cards"
            placeholder="Search cards…"
            value={searchText}
            onChange={(event) => onSearchChange(event.target.value)}
            className="min-h-11 w-full rounded-xl border border-slate-300 bg-white pr-14 pl-3.5 text-sm text-slate-900 placeholder:text-slate-400"
          />
          {searchText.length > 0 ? (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              Clear
            </button>
          ) : null}
        </div>

        <select
          aria-label="Filter by person"
          value={personFilter}
          onChange={(event) => onPersonFilterChange(event.target.value)}
          className="min-h-11 shrink-0 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 sm:max-w-44"
        >
          <option value="all">All people</option>
          <option value="me">Assigned to me</option>
          {users
            .filter((u) => u.id !== currentUserId)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} (@{u.handle})
              </option>
            ))}
        </select>
      </div>

      {availableTags.length > 0 ? (
        <div
          role="group"
          aria-label="Filter by tag"
          className="mt-2.5 flex min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5"
        >
          <button
            type="button"
            onClick={() => onTagChange(null)}
            aria-pressed={selectedTag === null}
            className={[
              'min-h-9 shrink-0 rounded-full px-3 py-1 text-xs font-medium transition',
              selectedTag === null
                ? 'bg-slate-900 text-white'
                : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
            ].join(' ')}
          >
            All
          </button>
          {availableTags.map((tag) => {
            const active = selectedTag === tag;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onTagChange(active ? null : tag)}
                aria-pressed={active}
                className={[
                  'min-h-9 shrink-0 rounded-full px-3 py-1 text-xs font-medium transition',
                  active
                    ? 'bg-sky-700 text-white'
                    : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
                ].join(' ')}
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
