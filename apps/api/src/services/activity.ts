import crypto from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  ActivitySchema,
  type Activity,
  type ActivityAction,
  type FieldDiff,
} from '@agent-kanban/shared';
import type { AuthContext } from '../types/express.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
      return false;
    }
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) {
        return false;
      }
      if (!deepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Computes field-level `{ from, to }` diffs for the requested fields using
 * deep structural equality.
 */
export function computeFieldDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): Record<string, FieldDiff> {
  const diff: Record<string, FieldDiff> = {};

  for (const field of fields) {
    const fromVal = before[field] === undefined ? null : before[field];
    const toVal = after[field] === undefined ? null : after[field];
    if (!deepEqual(fromVal, toVal)) {
      diff[field] = {
        from: fromVal,
        to: toVal,
      };
    }
  }

  return diff;
}

export interface BuildActivityEntryParams {
  id?: string;
  cardId: string;
  visibleToUserIds: string[];
  auth: Pick<AuthContext, 'actorType' | 'userId' | 'agentName' | 'platform'>;
  action: ActivityAction;
  diff?: Record<string, FieldDiff>;
  note?: string | null;
  createdAt: string;
}

/**
 * Builds and validates a canonical `Activity` document ready for persistence.
 */
export function buildActivityEntry(params: BuildActivityEntryParams): Activity {
  return ActivitySchema.parse({
    id: params.id ?? `act-${crypto.randomUUID()}`,
    cardId: params.cardId,
    visibleToUserIds: params.visibleToUserIds,
    actorType: params.auth.actorType,
    actorId: params.auth.userId,
    agentName: params.auth.agentName ?? null,
    platform: params.auth.platform ?? null,
    action: params.action,
    diff: params.diff ?? {},
    note: params.note ?? null,
    createdAt: params.createdAt,
  });
}

export function writeActivityInTransaction(tx: Transaction, db: Firestore, entry: Activity): void {
  tx.set(db.collection('activity').doc(entry.id), entry);
}

export async function writeActivity(db: Firestore, entry: Activity): Promise<Activity> {
  await db.collection('activity').doc(entry.id).set(entry);
  return entry;
}
