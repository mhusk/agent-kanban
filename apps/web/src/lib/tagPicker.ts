import { normalizeTag, normalizeTags } from '@agent-kanban/shared';

export const TAGS_QUERY_KEY = ['tags'] as const;

export const MAX_TAG_LENGTH = 50;
export const ONE_TAP_SUGGESTION_LIMIT = 5;
export const DROPDOWN_SUGGESTION_LIMIT = 8;

export interface TagVocabularyEntry {
  tag: string;
  openCount: number;
  totalCount: number;
}

export type TagPickerOption =
  | { kind: 'existing'; tag: string; openCount: number; totalCount: number }
  | { kind: 'create'; tag: string };

export interface TagCommitResult {
  tags: string[];
  error: string | null;
  changed: boolean;
}

export type TagKeyAction =
  | { type: 'move'; nextIndex: number }
  | { type: 'commit-suggestion'; index: number }
  | { type: 'commit-draft' }
  | { type: 'remove-last' }
  | { type: 'none' };

function tagsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function stripLeadingHashes(raw: string): string {
  let next = raw.trim();
  while (next.startsWith('#')) {
    next = next.slice(1).trim();
  }
  return next;
}

/** Lowercased tag text used for matching. Leading `#` characters are ignored. */
export function tagQueryFromDraft(draft: string): string {
  return normalizeTag(stripLeadingHashes(draft));
}

/** Canonical stored tag, or null when the draft is empty or longer than 50 characters. */
export function canonicalTagName(draft: string): string | null {
  const normalized = tagQueryFromDraft(draft);
  if (normalized.length === 0 || normalized.length > MAX_TAG_LENGTH) {
    return null;
  }
  return normalized;
}

export function normalizeTagList(tags: readonly string[]): string[] {
  return normalizeTags(tags.map((tag) => stripLeadingHashes(tag))).filter(
    (tag) => tag.length <= MAX_TAG_LENGTH,
  );
}

export function commitTag(selected: readonly string[], draft: string): TagCommitResult {
  const current = normalizeTagList(selected);
  const name = canonicalTagName(draft);
  if (name === null) {
    const query = tagQueryFromDraft(draft);
    return {
      tags: current,
      error:
        query.length > MAX_TAG_LENGTH
          ? `Tags must be ${MAX_TAG_LENGTH} characters or fewer.`
          : null,
      changed: !tagsEqual(current, selected),
    };
  }
  if (current.includes(name)) {
    return { tags: current, error: null, changed: !tagsEqual(current, selected) };
  }
  return { tags: [...current, name], error: null, changed: true };
}

export function commitTagParts(
  selected: readonly string[],
  parts: readonly string[],
): TagCommitResult {
  let tags = normalizeTagList(selected);
  let changed = !tagsEqual(tags, selected);
  let error: string | null = null;
  for (const part of parts) {
    const result = commitTag(tags, part);
    tags = result.tags;
    if (result.changed) {
      changed = true;
    }
    if (result.error) {
      error = result.error;
      break;
    }
  }
  return { tags, error, changed };
}

export function splitTagEntry(raw: string): { completed: string[]; remainder: string } {
  if (!raw.includes(',')) {
    return { completed: [], remainder: raw };
  }
  const parts = raw.split(',');
  const remainder = parts.pop() ?? '';
  return { completed: parts, remainder };
}

export function removeLastTag(selected: readonly string[]): string[] {
  return normalizeTagList(selected).slice(0, -1);
}

export function removeTag(selected: readonly string[], tag: string): string[] {
  const needle = normalizeTag(tag);
  return normalizeTagList(selected).filter((item) => item !== needle);
}

export function filterTagSuggestions<T extends TagVocabularyEntry>(
  vocabulary: readonly T[],
  selected: readonly string[],
  query: string,
  limit = DROPDOWN_SUGGESTION_LIMIT,
): T[] {
  const selectedSet = new Set(normalizeTagList(selected));
  const q = tagQueryFromDraft(query);
  const seen = new Set<string>();
  const matches: T[] = [];
  let exact: T | null = null;

  for (const item of vocabulary) {
    const tag = normalizeTag(item.tag);
    if (tag.length === 0 || seen.has(tag) || selectedSet.has(tag)) {
      continue;
    }
    if (q.length > 0 && !tag.includes(q)) {
      continue;
    }
    seen.add(tag);
    if (q.length > 0 && tag === q) {
      exact = item;
    }
    matches.push(item);
  }

  const limited = matches.slice(0, limit);
  if (exact && !limited.includes(exact)) {
    return [exact, ...limited.slice(0, Math.max(0, limit - 1))];
  }
  return limited;
}

export function topUnusedTags<T extends TagVocabularyEntry>(
  vocabulary: readonly T[],
  selected: readonly string[],
  limit = ONE_TAP_SUGGESTION_LIMIT,
): T[] {
  return filterTagSuggestions(vocabulary, selected, '', limit);
}

export function canCreateTag(
  vocabulary: readonly TagVocabularyEntry[],
  selected: readonly string[],
  draft: string,
): boolean {
  const name = canonicalTagName(draft);
  if (!name) {
    return false;
  }
  if (normalizeTagList(selected).includes(name)) {
    return false;
  }
  return !vocabulary.some((item) => normalizeTag(item.tag) === name);
}

export function buildTagPickerOptions(
  vocabulary: readonly TagVocabularyEntry[],
  selected: readonly string[],
  draft: string,
): TagPickerOption[] {
  const matches = filterTagSuggestions(vocabulary, selected, draft, DROPDOWN_SUGGESTION_LIMIT);
  const options: TagPickerOption[] = matches.map((item) => ({
    kind: 'existing',
    tag: normalizeTag(item.tag),
    openCount: item.openCount,
    totalCount: item.totalCount,
  }));
  if (canCreateTag(vocabulary, selected, draft)) {
    const name = canonicalTagName(draft);
    if (name) {
      options.push({ kind: 'create', tag: name });
    }
  }
  return options;
}

export function exactTagOptionIndex(options: readonly TagPickerOption[], draft: string): number {
  const name = canonicalTagName(draft);
  if (!name) {
    return -1;
  }
  return options.findIndex((option) => option.kind === 'existing' && option.tag === name);
}

export function resolveTagKeyAction(input: {
  key: string;
  draft: string;
  suggestionCount: number;
  activeIndex: number;
  exactIndex: number;
  hasTags: boolean;
}): TagKeyAction {
  const { key, draft, suggestionCount, activeIndex, exactIndex, hasTags } = input;

  if (key === 'ArrowDown') {
    if (suggestionCount <= 0) {
      return { type: 'none' };
    }
    const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % suggestionCount;
    return { type: 'move', nextIndex };
  }

  if (key === 'ArrowUp') {
    if (suggestionCount <= 0) {
      return { type: 'none' };
    }
    const nextIndex = activeIndex <= 0 ? suggestionCount - 1 : activeIndex - 1;
    return { type: 'move', nextIndex };
  }

  if (key === 'Enter') {
    if (activeIndex >= 0 && activeIndex < suggestionCount) {
      return { type: 'commit-suggestion', index: activeIndex };
    }
    if (exactIndex >= 0 && exactIndex < suggestionCount) {
      return { type: 'commit-suggestion', index: exactIndex };
    }
    if (tagQueryFromDraft(draft).length > 0) {
      return { type: 'commit-draft' };
    }
    return { type: 'none' };
  }

  if (key === ',') {
    if (tagQueryFromDraft(draft).length > 0) {
      return { type: 'commit-draft' };
    }
    return { type: 'none' };
  }

  if (key === 'Backspace' && draft.length === 0) {
    if (!hasTags) {
      return { type: 'none' };
    }
    return { type: 'remove-last' };
  }

  return { type: 'none' };
}

export function cardMatchesSelectedTag(
  tags: readonly string[],
  selectedTag: string | null,
): boolean {
  if (selectedTag === null) {
    return true;
  }
  const needle = normalizeTag(selectedTag);
  if (needle.length === 0) {
    return true;
  }
  return tags.some((tag) => normalizeTag(tag) === needle);
}

export function collectAvailableTags(cards: readonly { tags: readonly string[] }[]): string[] {
  const tags = new Set<string>();
  for (const card of cards) {
    for (const tag of card.tags) {
      const normalized = normalizeTag(tag);
      if (normalized.length > 0) {
        tags.add(normalized);
      }
    }
  }
  return Array.from(tags).sort((left, right) => left.localeCompare(right));
}

export function describeTagRenameResult(
  result: { fromTag: string; toTag: string | null; updatedCount: number },
  destinationAlreadyExisted: boolean,
): string {
  const fromLabel = `#${result.fromTag}`;
  if (result.updatedCount === 0) {
    return `No visible cards used ${fromLabel}.`;
  }
  const cardsLabel = result.updatedCount === 1 ? 'card' : 'cards';
  if (result.toTag === null) {
    return `Removed ${fromLabel} from ${result.updatedCount} ${cardsLabel}.`;
  }
  if (destinationAlreadyExisted) {
    return `Merged ${fromLabel} into #${result.toTag} on ${result.updatedCount} ${cardsLabel}.`;
  }
  return `Renamed ${fromLabel} to #${result.toTag} on ${result.updatedCount} ${cardsLabel}.`;
}
