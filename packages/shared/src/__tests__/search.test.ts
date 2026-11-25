import { describe, expect, it } from 'vitest';
import {
  MAX_SEARCH_PREFIX_LENGTH,
  MAX_SEARCH_TOKENS,
  buildSearchTokens,
  matchesSearchQuery,
  tokenizeQuery,
} from '../index.js';

describe('search tokenizer & card token builder', () => {
  it('normalizes case, strips punctuation, folds accents, and deduplicates query tokens', () => {
    expect(tokenizeQuery('  Café, HVAC-Filter!! café  filter  ')).toEqual([
      'cafe',
      'hvac',
      'filter',
    ]);
  });

  it('returns empty array for punctuation-only or single-character queries', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('   --- !!!   ')).toEqual([]);
    expect(tokenizeQuery('a b c 1')).toEqual([]);
  });

  it('builds prefix tokens of length 2..20 across title, checklists, and description', () => {
    const tokens = buildSearchTokens({
      title: 'Replace HVAC Filter',
      description: 'Order MERV-11 20x25x1 from hardware store.',
      checklists: [
        {
          title: 'Prep Steps',
          items: [{ text: 'Turn off thermostat' }, { text: 'Vacuum return grille' }],
        },
        {
          title: 'Disposal',
          items: [{ text: 'Recycle cardboard frame' }],
        },
      ],
    });

    expect(tokens).toContain('replace');
    expect(tokens).toContain('re');
    expect(tokens).toContain('rep');
    expect(tokens).toContain('thermostat');
    expect(tokens).toContain('thermo');
    expect(tokens).toContain('grille');
    expect(tokens).toContain('cardboard');
    expect(tokens).toContain('merv');
    expect(tokens).toContain('11');
    // Single-character token 'a' / '1' should not be present
    expect(tokens).not.toContain('r');
  });

  it('matches multi-word queries using AND semantics across title, checklists, and description', () => {
    const tokens = buildSearchTokens({
      title: 'Weekly Grocery Run',
      description: 'Pick up sparkling water and produce.',
      checklists: [
        {
          title: 'Dairy',
          items: [{ text: 'Organicoat milk' }, { text: 'Cheddar cheese' }],
        },
        {
          title: 'Pantry',
          items: [{ text: 'Sourdough bread' }],
        },
      ],
    });

    expect(matchesSearchQuery(tokens, 'grocery')).toBe(true);
    expect(matchesSearchQuery(tokens, 'groc chedd sour')).toBe(true);
    expect(matchesSearchQuery(tokens, 'weekly dairy sparkling')).toBe(true);
    expect(matchesSearchQuery(tokens, 'grocery missingword')).toBe(false);
    expect(matchesSearchQuery(tokens, '   ')).toBe(true);
  });

  it('caps total tokens at MAX_SEARCH_TOKENS while preserving title and checklist words', () => {
    const hugeWords = Array.from(
      { length: 650 },
      (_, i) => `descrword${String(i).padStart(4, '0')}`,
    );
    const tokens = buildSearchTokens({
      title: 'PriorityTitleToken',
      description: hugeWords.join(' '),
      checklists: [
        {
          title: 'ChecklistHeaderToken',
          items: [{ text: 'ChecklistItemToken' }],
        },
      ],
    });

    expect(tokens.length).toBeLessThanOrEqual(MAX_SEARCH_TOKENS);
    expect(tokens).toContain('prioritytitletoken');
    expect(tokens).toContain('checklistheadertoken');
    expect(tokens).toContain('checklistitemtoken');
  });

  it('truncates words longer than MAX_SEARCH_PREFIX_LENGTH consistently in index and query', () => {
    const longWord = 'supercalifragilisticexpialidocious';
    expect(longWord.length).toBeGreaterThan(MAX_SEARCH_PREFIX_LENGTH);

    const tokens = buildSearchTokens({
      title: longWord,
    });

    expect(tokens).toContain(longWord.slice(0, MAX_SEARCH_PREFIX_LENGTH));
    expect(matchesSearchQuery(tokens, longWord)).toBe(true);
    expect(matchesSearchQuery(tokens, 'supercalifragi')).toBe(true);
  });
});
