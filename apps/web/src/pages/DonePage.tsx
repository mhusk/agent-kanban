import { useState } from 'react';
import type { User } from '@agent-kanban/shared';
import { CardRow } from '../components/CardRow.js';
import { FilterBar } from '../components/FilterBar.js';
import { useFilteredCards } from '../hooks/useFilteredCards.js';

const DONE_STATUSES = ['done'] as const;

export function DonePage({ user }: { user: User }) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const {
    searchText,
    setSearchText,
    selectedTag,
    setSelectedTag,
    personFilter,
    setPersonFilter,
    availableTags,
    cards,
    users,
    usersById,
    isLoading,
    error,
    refetch,
    hasActiveFilters,
    clearFilters,
  } = useFilteredCards({
    statuses: DONE_STATUSES,
    archived: includeArchived ? 'all' : 'false',
    currentUserId: user.id,
    sort: 'updated',
  });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h1 id="main-content" tabIndex={-1} className="text-2xl font-semibold tracking-tight">
            Done
          </h1>
          {!isLoading ? (
            <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-700 tabular-nums">
              {cards.length}
            </span>
          ) : null}
        </div>

        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-sky-600"
          />
          Include archived
        </label>
      </div>

      <FilterBar
        searchText={searchText}
        onSearchChange={setSearchText}
        selectedTag={selectedTag}
        onTagChange={setSelectedTag}
        availableTags={availableTags}
        personFilter={personFilter}
        onPersonFilterChange={setPersonFilter}
        users={users}
        currentUserId={user.id}
      />

      {isLoading ? (
        <div className="space-y-2.5" aria-busy="true" aria-label="Loading completed cards">
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white" />
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-white p-4 text-sm">
          <p className="font-medium text-rose-800">
            {error instanceof Error ? error.message : 'Unable to load completed cards.'}
          </p>
          <button
            type="button"
            onClick={() => {
              void refetch();
            }}
            className="mt-3 min-h-11 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Retry
          </button>
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
          {hasActiveFilters ? (
            <>
              <p>No completed cards match your current filters.</p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100"
              >
                Clear filters
              </button>
            </>
          ) : (
            <p>No completed cards yet.</p>
          )}
        </div>
      ) : (
        <ul className="space-y-2.5">
          {cards.map((card) => (
            <CardRow
              key={card.id}
              card={card}
              usersById={usersById}
              showArchivedBadge={includeArchived}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
