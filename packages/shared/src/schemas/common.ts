import { z } from 'zod';

export const EntityIdSchema = z.string().trim().min(1).max(128);

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const TagSchema = z.string().trim().min(1).max(50);

/**
 * Canonical tag form: trimmed and lowercased.
 * Matching and vocabulary aggregation use this so pre-v1.1 mixed-case tags still collide.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Trims, lowercases, and dedupes tags, preserving the first occurrence's order.
 * Empty strings are dropped.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** Write-path tag list. `CardSchema` keeps the plain `TagSchema` so stored mixed-case docs still parse. */
export const NormalizedTagsSchema = z.array(TagSchema).transform((tags) => normalizeTags(tags));

export const HandleSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Handle must start with a letter/digit and use a-z, 0-9, _, -');

export const NoteSchema = z.string().trim().min(1).max(1000);

export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || tz.trim() !== tz) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const IanaTimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidIanaTimezone, { message: 'Invalid IANA timezone' });

export const HttpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'URL must use http or https protocol' },
  );

export const HttpsUrlSchema = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'URL must use https protocol' },
  );

export const DevWebhookUrlSchema = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        if (parsed.protocol === 'https:') {
          return true;
        }
        return (
          parsed.protocol === 'http:' &&
          (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
        );
      } catch {
        return false;
      }
    },
    { message: 'Webhook URL must use https (or http://localhost / http://127.0.0.1 in emulator)' },
  );
