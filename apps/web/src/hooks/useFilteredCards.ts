import { useEffect, useMemo, useState } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { Card, CardStatus, User } from '@agent-kanban/shared';
import { fetchCards, fetchHouseholdUsers, searchCards } from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';
import { TAGS_QUERY_KEY, cardMatchesSelectedTag, collectAvailableTags } from '../lib/tagPicker.js';

export function invalidateCardsAndTags(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['cards'] }),
    queryClient.invalidateQueries({ queryKey: ['schedule'] }),
    queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY }),
  ]).then(() => undefined);
}

export type PersonFilterValue = 'all' | 'me' | string;

export interface UseFilteredCardsOptions {
  statuses: readonly CardStatus[];
  archived?: 'true' | 'false' | 'all';
  includeAllArchivedStatuses?: boolean;
  currentUserId: string;
  sort?: 'priority' | 'updated';
}

export interface UseFilteredCardsResult {
  searchText: string;
  setSearchText: (value: string) => void;
  selectedTag: string | null;
  setSelectedTag: (value: string | null) => void;
  personFilter: PersonFilterValue;
  setPersonFilter: (value: PersonFilterValue) => void;
  availableTags: string[];
  cards: Card[];
  allStatusCards: Card[];
  users: User[];
  usersById: Map<string, User>;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
  hasActiveFilters: boolean;
  clearFilters: () => void;
}

export function useFilteredCards({
  statuses,
  archived = 'false',
  includeAllArchivedStatuses = false,
  currentUserId,
  sort,
}: UseFilteredCardsOptions): UseFilteredCardsResult {
  const { getAccessToken } = useAppAuth();
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [personFilter, setPersonFilter] = useState<PersonFilterValue>('all');

  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed.length === 0) {
      setDebouncedSearch('');
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedSearch(trimmed);
    }, 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [searchText]);

  const statusKey = statuses.join(',');

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => fetchHouseholdUsers(getAccessToken, signal),
    staleTime: 60_000,
  });

  const cardsQuery = useQuery({
    queryKey: [
      'cards',
      { status: statusKey, archived, includeAllArchivedStatuses, sort, q: debouncedSearch },
    ],
    queryFn: async ({ signal }) => {
      if (debouncedSearch.length > 0) {
        const searched = await searchCards(getAccessToken, debouncedSearch, archived, signal);
        return searched.filter(
          (card) => statuses.includes(card.status) || (includeAllArchivedStatuses && card.archived),
        );
      }
      if (includeAllArchivedStatuses) {
        const fetched = await fetchCards(
          getAccessToken,
          {
            archived,
            ...(sort !== undefined ? { sort } : {}),
          },
          signal,
        );
        return fetched.filter((card) => statuses.includes(card.status) || card.archived);
      }
      return fetchCards(
        getAccessToken,
        {
          status: statusKey,
          archived,
          ...(sort !== undefined ? { sort } : {}),
        },
        signal,
      );
    },
  });

  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const allStatusCards = useMemo(() => cardsQuery.data ?? [], [cardsQuery.data]);

  const availableTags = useMemo(() => collectAvailableTags(allStatusCards), [allStatusCards]);

  const filteredCards = useMemo(() => {
    return allStatusCards.filter((card) => {
      if (!cardMatchesSelectedTag(card.tags, selectedTag)) {
        return false;
      }
      if (personFilter === 'me') {
        if (!card.assignedUserIds.includes(currentUserId)) {
          return false;
        }
      } else if (personFilter !== 'all') {
        if (!card.assignedUserIds.includes(personFilter)) {
          return false;
        }
      }
      return true;
    });
  }, [allStatusCards, selectedTag, personFilter, currentUserId]);

  const hasActiveFilters =
    searchText.trim().length > 0 || selectedTag !== null || personFilter !== 'all';

  const clearFilters = () => {
    setSearchText('');
    setDebouncedSearch('');
    setSelectedTag(null);
    setPersonFilter('all');
  };

  return {
    searchText,
    setSearchText,
    selectedTag,
    setSelectedTag,
    personFilter,
    setPersonFilter,
    availableTags,
    cards: filteredCards,
    allStatusCards,
    users,
    usersById,
    isLoading: cardsQuery.isPending,
    isFetching: cardsQuery.isFetching,
    error: cardsQuery.error,
    refetch: () => cardsQuery.refetch(),
    hasActiveFilters,
    clearFilters,
  };
}
