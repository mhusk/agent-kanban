import type { User } from '@agent-kanban/shared';
import { CardRow } from '../components/CardRow.js';
import { FilterBar } from '../components/FilterBar.js';
import { useFilteredCards } from '../hooks/useFilteredCards.js';

const ACTIVE_STATUSES = ['doing', 'blocked'] as const;

export function ActivePage({ user }: { user: User }) {
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
    statuses: ACTIVE_STATUSES,
    archived: 'false',
    currentUserId: user.id,
    sort: 'updated',
  });

  const doingCards = cards.filter((card) => card.status === 'doing');
  const blockedCards = cards.filter((card) => card.status === 'blocked');

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 id="main-content" tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          Active
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
        <div className="space-y-2.5" aria-busy="true" aria-label="Loading active cards">
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white" />
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-white p-4 text-sm">
          <p className="font-medium text-rose-800">
            {error instanceof Error ? error.message : 'Unable to load active cards.'}
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
      ) : (
        <div className="space-y-6">
          <section aria-labelledby="doing-heading" className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h2
                id="doing-heading"
                className="text-sm font-semibold tracking-wide text-slate-600 uppercase"
              >
                Doing ({doingCards.length})
              </h2>
            </div>
            {doingCards.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                {hasActiveFilters ? 'No Doing cards match your filters.' : 'Nothing in progress.'}
              </p>
            ) : (
              <ul className="space-y-2.5">
                {doingCards.map((card) => (
                  <CardRow key={card.id} card={card} usersById={usersById} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="blocked-heading" className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h2
                id="blocked-heading"
                className="text-sm font-semibold tracking-wide text-slate-600 uppercase"
              >
                Blocked ({blockedCards.length})
              </h2>
            </div>
            {blockedCards.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                {hasActiveFilters ? 'No Blocked cards match your filters.' : 'No blocked cards.'}
              </p>
            ) : (
              <ul className="space-y-2.5">
                {blockedCards.map((card) => (
                  <CardRow key={card.id} card={card} usersById={usersById} />
                ))}
              </ul>
            )}
          </section>

          {hasActiveFilters && cards.length === 0 ? (
            <button
              type="button"
              onClick={clearFilters}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
