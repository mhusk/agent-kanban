export const MIN_SEARCH_TOKEN_LENGTH = 2;
export const MAX_SEARCH_PREFIX_LENGTH = 20;
export const MAX_SEARCH_TOKENS = 500;

export interface SearchableChecklist {
  title: string;
  items?: ReadonlyArray<{ text: string }>;
}

export interface SearchableCardContent {
  title: string;
  description?: string | null;
  checklists?: ReadonlyArray<SearchableChecklist> | null;
}

/**
 * Normalizes text into lowercase alphanumeric words, folding accents and
 * dropping tokens shorter than MIN_SEARCH_TOKEN_LENGTH.
 */
function extractNormalizedWords(text: string): string[] {
  const folded = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const rawParts = folded.split(/[^a-z0-9]+/);
  const words: string[] = [];

  for (const part of rawParts) {
    if (part.length < MIN_SEARCH_TOKEN_LENGTH) {
      continue;
    }
    words.push(part.slice(0, MAX_SEARCH_PREFIX_LENGTH));
  }

  return words;
}

/**
 * Tokenizes a user search query into unique normalized terms in query order.
 */
export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const word of extractNormalizedWords(query)) {
    if (!seen.has(word)) {
      seen.add(word);
      tokens.push(word);
    }
  }

  return tokens;
}

/**
 * Builds deduplicated full-word and prefix search tokens for a card,
 * prioritizing title, then checklists, then description within MAX_SEARCH_TOKENS.
 */
export function buildSearchTokens(content: SearchableCardContent): string[] {
  const orderedWords: string[] = [];

  orderedWords.push(...extractNormalizedWords(content.title));

  if (content.checklists) {
    for (const checklist of content.checklists) {
      orderedWords.push(...extractNormalizedWords(checklist.title));
      if (checklist.items) {
        for (const item of checklist.items) {
          orderedWords.push(...extractNormalizedWords(item.text));
        }
      }
    }
  }

  if (content.description) {
    orderedWords.push(...extractNormalizedWords(content.description));
  }

  const tokens = new Set<string>();

  // Pass 1: Add full words in priority order so title/checklist terms are never evicted.
  for (const word of orderedWords) {
    if (tokens.size >= MAX_SEARCH_TOKENS) {
      return Array.from(tokens);
    }
    tokens.add(word);
  }

  // Pass 2: Add prefix tokens (lengths 2..20) in priority order up to MAX_SEARCH_TOKENS.
  for (const word of orderedWords) {
    const maxLen = Math.min(word.length, MAX_SEARCH_PREFIX_LENGTH);
    for (let len = MIN_SEARCH_TOKEN_LENGTH; len <= maxLen; len += 1) {
      if (tokens.size >= MAX_SEARCH_TOKENS) {
        return Array.from(tokens);
      }
      tokens.add(word.slice(0, len));
    }
  }

  return Array.from(tokens);
}

/**
 * Returns true if every normalized query token exists in the card's searchTokens.
 */
export function matchesSearchQuery(searchTokens: readonly string[], query: string): boolean {
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) {
    return true;
  }

  const tokenSet = new Set(searchTokens);
  return queryTokens.every((token) => tokenSet.has(token));
}
