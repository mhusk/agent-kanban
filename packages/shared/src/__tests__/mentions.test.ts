import { describe, expect, it } from 'vitest';
import { MAX_MENTION_HANDLE_LENGTH, extractMentionHandles } from '../index.js';

describe('extractMentionHandles', () => {
  it('extracts single and multiple @mentions, normalizes to lowercase, and deduplicates in order', () => {
    expect(extractMentionHandles('Hey @Sam, please sync with @alex and @SAM later.')).toEqual([
      'sam',
      'alex',
    ]);
  });

  it('handles punctuation boundaries and multiline comments cleanly', () => {
    const text = [
      '(@sam) could you check this?',
      'Looping [@Alex_1] and "@taylor-2".',
      "Ping @morgan. Also check @riley's note!",
    ].join('\n');

    expect(extractMentionHandles(text)).toEqual(['sam', 'alex_1', 'taylor-2', 'morgan', 'riley']);
  });

  it('ignores email addresses while extracting real @mentions in the same text', () => {
    expect(
      extractMentionHandles(
        'Email alex@example.test or first.last+tag@example.org or not-a-mention@example.test; cc @sam.',
      ),
    ).toEqual(['sam']);
  });

  it('ignores malformed handles, double-@ prefixes, and handles exceeding max length', () => {
    const overlong = 'a'.repeat(MAX_MENTION_HANDLE_LENGTH + 1);
    const exactMax = 'b'.repeat(MAX_MENTION_HANDLE_LENGTH);

    const text = `bare @ and @@sam and @-bad and @_bad and @alex@example.test and @${overlong} and @${exactMax}`;
    expect(extractMentionHandles(text)).toEqual([exactMax]);
  });
});
