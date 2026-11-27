import { describe, expect, it } from 'vitest';
import {
  DROPDOWN_SUGGESTION_LIMIT,
  buildTagPickerOptions,
  canonicalTagName,
  cardMatchesSelectedTag,
  collectAvailableTags,
  commitTag,
  commitTagParts,
  describeTagRenameResult,
  exactTagOptionIndex,
  removeLastTag,
  resolveTagKeyAction,
  splitTagEntry,
  topUnusedTags,
  type TagVocabularyEntry,
} from '../lib/tagPicker.js';

const vocabulary: TagVocabularyEntry[] = [
  { tag: 'groceries', openCount: 4, totalCount: 5 },
  { tag: 'Home', openCount: 2, totalCount: 2 },
  { tag: 'errands', openCount: 1, totalCount: 3 },
];

const key = {
  suggestionCount: 3,
  activeIndex: -1,
  exactIndex: -1,
  hasTags: true,
};

describe('tag name helpers', () => {
  it('normalizes case, whitespace, and a leading hash', () => {
    expect(canonicalTagName('  #Groceries ')).toBe('groceries');
    expect(canonicalTagName('# #Yard')).toBe('yard');
    expect(canonicalTagName('   ')).toBeNull();
    expect(canonicalTagName('#')).toBeNull();
    expect(canonicalTagName('a'.repeat(51))).toBeNull();
  });

  it('commits lowercase deduped tags and rejects overly long names', () => {
    expect(commitTag(['Home'], '  #Yard ')).toEqual({
      tags: ['home', 'yard'],
      error: null,
      changed: true,
    });
    expect(commitTag(['Home'], 'HOME')).toEqual({
      tags: ['home'],
      error: null,
      changed: true,
    });
    expect(commitTag(['home'], 'home')).toEqual({
      tags: ['home'],
      error: null,
      changed: false,
    });
    expect(commitTag(['errands'], 'a'.repeat(51)).error).toBe(
      'Tags must be 50 characters or fewer.',
    );
    expect(commitTagParts([], ['Groceries', ' groceries ', 'Home'])).toEqual({
      tags: ['groceries', 'home'],
      error: null,
      changed: true,
    });
    expect(splitTagEntry('Home, Yard,')).toEqual({
      completed: ['Home', ' Yard'],
      remainder: '',
    });
    expect(removeLastTag(['groceries', 'home'])).toEqual(['groceries']);
  });
});

describe('TagPicker suggestions', () => {
  it('keeps frequency order, hides selected tags, and offers inline creation', () => {
    expect(buildTagPickerOptions(vocabulary, [], 'GRO')).toEqual([
      { kind: 'existing', tag: 'groceries', openCount: 4, totalCount: 5 },
      { kind: 'create', tag: 'gro' },
    ]);
    expect(buildTagPickerOptions(vocabulary, ['#Groceries'], 'gro')).toEqual([
      { kind: 'create', tag: 'gro' },
    ]);
    expect(buildTagPickerOptions(vocabulary, ['groceries'], 'groceries')).toEqual([]);
    expect(topUnusedTags(vocabulary, ['home']).map((item) => item.tag)).toEqual([
      'groceries',
      'errands',
    ]);
  });

  it('pins an exact match that would otherwise fall past the dropdown limit', () => {
    const crowded: TagVocabularyEntry[] = Array.from(
      { length: DROPDOWN_SUGGESTION_LIMIT + 1 },
      (_, index) => ({
        tag: index === DROPDOWN_SUGGESTION_LIMIT ? 'zeta' : `zeta${index}`,
        openCount: 20 - index,
        totalCount: 20 - index,
      }),
    );
    const options = buildTagPickerOptions(crowded, [], 'zeta');
    expect(options[0]).toMatchObject({ kind: 'existing', tag: 'zeta' });
    expect(options).toHaveLength(DROPDOWN_SUGGESTION_LIMIT);
    expect(options.some((option) => option.kind === 'create')).toBe(false);
    expect(exactTagOptionIndex(options, '#Zeta')).toBe(0);
  });
});

describe('TagPicker keyboard actions', () => {
  it('moves the highlight with arrows, wrapping at both ends', () => {
    expect(resolveTagKeyAction({ ...key, key: 'ArrowDown', draft: '' })).toEqual({
      type: 'move',
      nextIndex: 0,
    });
    expect(resolveTagKeyAction({ ...key, key: 'ArrowDown', draft: '', activeIndex: 2 })).toEqual({
      type: 'move',
      nextIndex: 0,
    });
    expect(resolveTagKeyAction({ ...key, key: 'ArrowUp', draft: '', activeIndex: 0 })).toEqual({
      type: 'move',
      nextIndex: 2,
    });
    expect(
      resolveTagKeyAction({ ...key, key: 'ArrowDown', draft: 'a', suggestionCount: 0 }),
    ).toEqual({ type: 'none' });
  });

  it('commits the highlight, an exact match, or the typed draft', () => {
    expect(
      resolveTagKeyAction({ ...key, key: 'Enter', draft: 'gro', activeIndex: 1, exactIndex: 0 }),
    ).toEqual({ type: 'commit-suggestion', index: 1 });
    expect(
      resolveTagKeyAction({ ...key, key: 'Enter', draft: 'groceries', exactIndex: 0 }),
    ).toEqual({ type: 'commit-suggestion', index: 0 });
    expect(resolveTagKeyAction({ ...key, key: 'Enter', draft: 'gro' })).toEqual({
      type: 'commit-draft',
    });
    expect(resolveTagKeyAction({ ...key, key: ',', draft: ' yard ' })).toEqual({
      type: 'commit-draft',
    });
    expect(resolveTagKeyAction({ ...key, key: 'Enter', draft: '' })).toEqual({ type: 'none' });
    expect(resolveTagKeyAction({ ...key, key: ',', draft: '   ' })).toEqual({ type: 'none' });
  });

  it('removes the last chip with Backspace only when the draft is empty', () => {
    expect(resolveTagKeyAction({ ...key, key: 'Backspace', draft: '' })).toEqual({
      type: 'remove-last',
    });
    expect(resolveTagKeyAction({ ...key, key: 'Backspace', draft: 'a' })).toEqual({
      type: 'none',
    });
    expect(resolveTagKeyAction({ ...key, key: 'Backspace', draft: '', hasTags: false })).toEqual({
      type: 'none',
    });
  });
});

describe('case-insensitive tag filters and rename copy', () => {
  it('matches filters and collects a lowercase vocabulary', () => {
    expect(cardMatchesSelectedTag(['Home', 'Groceries'], 'GROCERIES')).toBe(true);
    expect(cardMatchesSelectedTag(['Home'], 'groceries')).toBe(false);
    expect(cardMatchesSelectedTag(['Home'], null)).toBe(true);
    expect(
      collectAvailableTags([{ tags: ['Groceries', 'Home'] }, { tags: [' groceries ', 'Errands'] }]),
    ).toEqual(['errands', 'groceries', 'home']);
  });

  it('describes rename, merge, remove, and no-op results', () => {
    expect(
      describeTagRenameResult({ fromTag: 'groceries', toTag: 'shopping', updatedCount: 2 }, false),
    ).toBe('Renamed #groceries to #shopping on 2 cards.');
    expect(
      describeTagRenameResult({ fromTag: 'groceries', toTag: 'shopping', updatedCount: 3 }, true),
    ).toBe('Merged #groceries into #shopping on 3 cards.');
    expect(
      describeTagRenameResult({ fromTag: 'errands', toTag: null, updatedCount: 1 }, false),
    ).toBe('Removed #errands from 1 card.');
    expect(
      describeTagRenameResult({ fromTag: 'missing', toTag: null, updatedCount: 0 }, false),
    ).toBe('No visible cards used #missing.');
  });
});
