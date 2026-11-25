export const MAX_MENTION_HANDLE_LENGTH = 32;

const MENTION_PATTERN =
  /(?<![A-Za-z0-9._%+@-])@([A-Za-z0-9][A-Za-z0-9_-]*)(?![A-Za-z0-9_@-]|\.[A-Za-z0-9._%+-]*@)/g;

/**
 * Extracts unique lowercased @mention handles from text while ignoring email addresses
 * and invalid handles.
 */
export function extractMentionHandles(text: string): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];

  MENTION_PATTERN.lastIndex = 0;
  let match = MENTION_PATTERN.exec(text);

  while (match !== null) {
    const rawHandle = match[1];
    if (rawHandle && rawHandle.length <= MAX_MENTION_HANDLE_LENGTH) {
      const normalized = rawHandle.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        handles.push(normalized);
      }
    }
    match = MENTION_PATTERN.exec(text);
  }

  return handles;
}
