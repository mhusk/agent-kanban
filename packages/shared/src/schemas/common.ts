import { z } from 'zod';

export const EntityIdSchema = z.string().trim().min(1).max(128);

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const TagSchema = z.string().trim().min(1).max(50);

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
