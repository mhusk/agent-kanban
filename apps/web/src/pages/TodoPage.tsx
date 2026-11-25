import { useState } from 'react';
import type { User } from '@agent-kanban/shared';
import { CardRow } from '../components/CardRow.js';
import { FilterBar } from '../components/FilterBar.js';
import { useFilteredCards } from '../hooks/useFilteredCards.js';

const TOP_TODO_LIMIT = 5;
const TODO_STATUSES = ['todo'] as const;

export function TodoPage({ user }: { user: User }) {
  const [showMore, setShowMore] = useState(false);
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
    statuses: TODO_STATUSES,
    archived: 'false',
    currentUserId: user.id,
    sort: 'priority',
  });

  const topCards = cards.slice(0, TOP_TODO_LIMIT);
  const remainingCards = cards.slice(TOP_TODO_LIMIT);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 id="main-content" tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          To-Do
        </h1>
        {!isLoading ? (
          <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-700 tabular-nums">
            {cards.length}
          </span>
        ) : null}
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
        <div className="space-y-2.5" aria-busy="true" aria-label="Loading To-Do cards">
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white" />
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white" />
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-white p-4 text-sm">
          <p className="font-medium text-rose-800">
            {error instanceof Error ? error.message : 'Unable to load To-Do cards.'}
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
              <p>No To-Do cards match your current filters.</p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100"
              >
                Clear filters
              </button>
            </>
          ) : (
            <p>No To-Do cards yet. Tap the + button to add your first task.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2.5">
            {topCards.map((card) => (
              <CardRow key={card.id} card={card} usersById={usersById} />
            ))}
          </ul>

          {remainingCards.length > 0 ? (
            <div className="space-y-2.5">
              <button
                type="button"
                aria-expanded={showMore}
                onClick={() => setShowMore((prev) => !prev)}
                className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-100"
              >
                {showMore
                  ? `Hide ${remainingCards.length} more`
                  : `Show ${remainingCards.length} more`}
              </button>

              {showMore ? (
                <ul className="space-y-2.5">
                  {remainingCards.map((card) => (
                    <CardRow key={card.id} card={card} usersById={usersById} />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
