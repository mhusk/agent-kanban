import type { Activity, Card, Recurrence, User } from '@agent-kanban/shared';
import { describeRecurrence } from './recurrenceUi.js';

export interface DueMeta {
  label: string;
  isOverdue: boolean;
  isDueSoon: boolean;
  isFirm: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatDueMeta(
  card: Pick<Card, 'due' | 'dueHasTime' | 'dueFirm'>,
  now: Date = new Date(),
): DueMeta | null {
  if (card.due === null) {
    return null;
  }

  if (!card.dueHasTime) {
    const dateKey = card.due.slice(0, 10);
    const [yearStr, monthStr, dayStr] = dateKey.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }

    const todayKey = toLocalDateKey(now);
    const dueUtcDay = Date.UTC(year, month - 1, day);
    const [todayY, todayM, todayD] = todayKey.split('-').map(Number);
    const todayUtcDay = Date.UTC(todayY!, todayM! - 1, todayD!);
    const dayDiff = Math.round((dueUtcDay - todayUtcDay) / MS_PER_DAY);

    let label: string;
    if (dayDiff === 0) {
      label = 'Today';
    } else if (dayDiff === 1) {
      label = 'Tomorrow';
    } else if (dayDiff === -1) {
      label = 'Yesterday';
    } else {
      const displayDate = new Date(year, month - 1, day);
      label = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
        displayDate,
      );
    }

    return {
      label,
      isOverdue: dayDiff < 0,
      isDueSoon: dayDiff >= 0 && dayDiff <= 2,
      isFirm: card.dueFirm,
    };
  }

  const dueMs = Date.parse(card.due);
  if (!Number.isFinite(dueMs)) {
    return null;
  }

  const nowMs = now.getTime();
  const diffMs = dueMs - nowMs;
  const dueDate = new Date(dueMs);

  const label = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(dueDate);

  return {
    label,
    isOverdue: diffMs < 0,
    isDueSoon: diffMs >= 0 && diffMs <= 2 * MS_PER_DAY,
    isFirm: card.dueFirm,
  };
}

export function getUserInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

export function getChecklistProgress(card: Pick<Card, 'checklists'>): {
  checked: number;
  total: number;
} {
  let checked = 0;
  let total = 0;
  for (const checklist of card.checklists) {
    for (const item of checklist.items) {
      total += 1;
      if (item.checked) {
        checked += 1;
      }
    }
  }
  return { checked, total };
}

export function formatActorLabel(
  entry: {
    actorType: string;
    actorId: string;
    agentName: string | null;
    platform: string | null;
  },
  usersById: ReadonlyMap<string, User>,
): string {
  if (entry.actorType === 'agent') {
    const agentName = entry.agentName?.trim() || null;
    const platform = entry.platform?.trim() || null;

    if (agentName && platform) {
      if (agentName.toLowerCase() === platform.toLowerCase()) {
        return `${platform} (agent)`;
      }
      return `${agentName} via ${platform} (agent)`;
    }
    return `${agentName ?? platform ?? 'Agent'} (agent)`;
  }
  if (entry.actorType === 'system') {
    return 'System';
  }
  return usersById.get(entry.actorId)?.displayName ?? entry.actorId;
}

const STATUS_LABELS: Record<string, string> = {
  todo: 'To-Do',
  doing: 'Doing',
  blocked: 'Blocked',
  done: 'Done',
};

function formatStatusLabel(value: unknown): string {
  if (typeof value === 'string' && value in STATUS_LABELS) {
    return STATUS_LABELS[value]!;
  }
  return typeof value === 'string' ? value : String(value ?? 'None');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getStringField(value: unknown, key: string): string | null {
  const rec = asRecord(value);
  const field = rec?.[key];
  return typeof field === 'string' && field.trim().length > 0 ? field.trim() : null;
}

function formatDueValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return 'None';
  }
  if (typeof value !== 'string') {
    return String(value);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return value;
  }
  if (value.endsWith('T00:00:00.000Z')) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(ms));
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

function formatUserList(value: unknown, usersById: ReadonlyMap<string, User>): string {
  if (!Array.isArray(value) || value.length === 0) {
    return 'None';
  }
  return value
    .map((id) => {
      if (typeof id !== 'string') {
        return String(id);
      }
      return usersById.get(id)?.displayName ?? id;
    })
    .join(', ');
}

function formatRecurrenceValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  const rec = asRecord(value) as Partial<Recurrence> | null;
  if (!rec) {
    return String(value);
  }
  if (rec.type === 'cron' && typeof rec.expression === 'string') {
    return describeRecurrence({
      type: 'cron',
      expression: rec.expression,
      ...(typeof rec.timezone === 'string' ? { timezone: rec.timezone } : {}),
    });
  }
  if (rec.type === 'interval_after_completion' && typeof rec.every === 'number' && rec.unit) {
    return describeRecurrence({
      type: 'interval_after_completion',
      every: rec.every,
      unit: rec.unit,
      ...(typeof rec.timezone === 'string' ? { timezone: rec.timezone } : {}),
    });
  }
  return 'Custom';
}

function formatBoolValue(value: unknown): string {
  return value ? 'Yes' : 'No';
}

function formatTagsDiff(from: unknown, to: unknown): string {
  const fromTags = Array.isArray(from)
    ? from.filter((t): t is string => typeof t === 'string')
    : [];
  const toTags = Array.isArray(to) ? to.filter((t): t is string => typeof t === 'string') : [];
  const fromSet = new Set(fromTags);
  const toSet = new Set(toTags);
  const added = toTags.filter((t) => !fromSet.has(t)).map((t) => `#${t}`);
  const removed = fromTags.filter((t) => !toSet.has(t)).map((t) => `#${t}`);
  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`added ${added.join(', ')}`);
  }
  if (removed.length > 0) {
    parts.push(`removed ${removed.join(', ')}`);
  }
  if (parts.length > 0) {
    return `Tags: ${parts.join('; ')}`;
  }
  return `Tags: ${toTags.length > 0 ? toTags.map((t) => `#${t}`).join(', ') : 'None'}`;
}

function formatFallbackValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'string') {
    return value.length > 80 ? `"${value.slice(0, 77)}…"` : `"${value}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? 'None' : value.map(String).join(', ');
  }
  return JSON.stringify(value);
}

function formatUpdatedFieldDiff(
  key: string,
  from: unknown,
  to: unknown,
  usersById: ReadonlyMap<string, User>,
): string {
  switch (key) {
    case 'title':
      return `Title: "${String(from ?? '')}" → "${String(to ?? '')}"`;
    case 'description':
      if (!from && to) {
        return 'Added description';
      }
      if (from && !to) {
        return 'Cleared description';
      }
      return 'Updated description';
    case 'status':
      return `Status: ${formatStatusLabel(from)} → ${formatStatusLabel(to)}`;
    case 'tags':
      return formatTagsDiff(from, to);
    case 'assignedUserIds':
      return `Assigned: ${formatUserList(from, usersById)} → ${formatUserList(to, usersById)}`;
    case 'awareUserIds':
      return `Shared with: ${formatUserList(from, usersById)} → ${formatUserList(to, usersById)}`;
    case 'visibleToUserIds':
      return `Visible to: ${formatUserList(from, usersById)} → ${formatUserList(to, usersById)}`;
    case 'due':
      return `Due date: ${formatDueValue(from)} → ${formatDueValue(to)}`;
    case 'dueFirm':
      return `Firm deadline: ${formatBoolValue(from)} → ${formatBoolValue(to)}`;
    case 'dueHasTime':
      return `Include time: ${formatBoolValue(from)} → ${formatBoolValue(to)}`;
    case 'priorityScore':
      return `Priority score: ${from ?? 'Unscored'} → ${to ?? 'Unscored'}`;
    case 'priorityReason':
      return `Priority reason: ${from ? `"${String(from)}"` : 'None'} → ${to ? `"${String(to)}"` : 'None'}`;
    case 'recurrence':
      return `Recurrence: ${formatRecurrenceValue(from)} → ${formatRecurrenceValue(to)}`;
    case 'archived':
      return `Archived: ${formatBoolValue(from)} → ${formatBoolValue(to)}`;
    default:
      return `${key}: ${formatFallbackValue(from)} → ${formatFallbackValue(to)}`;
  }
}

export interface ActivitySummary {
  headline: string;
  details: string[];
}

export function formatActivitySummary(
  entry: Pick<Activity, 'action' | 'diff'>,
  usersById: ReadonlyMap<string, User>,
): ActivitySummary {
  const diff = entry.diff ?? {};

  switch (entry.action) {
    case 'card.created':
      return { headline: 'created this card', details: [] };

    case 'card.status_changed': {
      const statusDiff = diff.status;
      if (statusDiff) {
        return {
          headline: `changed status from ${formatStatusLabel(statusDiff.from)} to ${formatStatusLabel(statusDiff.to)}`,
          details: [],
        };
      }
      return { headline: 'changed status', details: [] };
    }

    case 'card.completed': {
      const isReset = Boolean(diff.due || diff.checklists);
      const details: string[] = [];
      if (diff.due) {
        details.push(`Next due: ${formatDueValue(diff.due.to)}`);
      }
      if (diff.status && diff.status.to !== diff.status.from) {
        details.push(
          `Status: ${formatStatusLabel(diff.status.from)} → ${formatStatusLabel(diff.status.to)}`,
        );
      }
      return {
        headline: isReset ? 'completed & reset this card' : 'completed this card',
        details,
      };
    }

    case 'card.archived':
      return { headline: 'archived this card', details: [] };

    case 'card.unarchived':
      return { headline: 'unarchived this card', details: [] };

    case 'card.auto_archived':
      return { headline: 'auto-archived this card', details: [] };

    case 'card.commented': {
      const rawText =
        getStringField(diff.comment?.to, 'text') ??
        (typeof diff.comment?.to === 'string' ? diff.comment.to.trim() : null);
      if (!rawText) {
        return { headline: 'commented', details: [] };
      }
      const preview = rawText.length > 140 ? `${rawText.slice(0, 137)}…` : rawText;
      return { headline: 'commented', details: [`"${preview}"`] };
    }

    case 'card.rescore_requested':
      return { headline: 'requested an AI rescore', details: [] };

    case 'card.prioritized': {
      const details: string[] = [];
      if (diff.priorityScore) {
        details.push(
          `Score: ${diff.priorityScore.from ?? 'Unscored'} → ${diff.priorityScore.to ?? 'Unscored'}`,
        );
      }
      if (diff.priorityReason?.to) {
        details.push(`Reason: "${String(diff.priorityReason.to)}"`);
      }
      return { headline: 'updated priority', details };
    }

    case 'card.checklist_created': {
      const title = getStringField(diff.checklist?.to, 'title');
      return {
        headline: title ? `added checklist "${title}"` : 'added a checklist',
        details: [],
      };
    }

    case 'card.checklist_updated': {
      const fromTitle = getStringField(diff.checklist?.from, 'title');
      const toTitle = getStringField(diff.checklist?.to, 'title');
      if (fromTitle && toTitle && fromTitle !== toTitle) {
        return {
          headline: `renamed checklist "${fromTitle}" to "${toTitle}"`,
          details: [],
        };
      }
      return {
        headline: toTitle ? `updated checklist "${toTitle}"` : 'updated a checklist',
        details: [],
      };
    }

    case 'card.checklist_deleted': {
      const title = getStringField(diff.checklist?.from, 'title');
      return {
        headline: title ? `deleted checklist "${title}"` : 'deleted a checklist',
        details: [],
      };
    }

    case 'card.checklist_item_added': {
      const text = getStringField(diff.checklistItem?.to, 'text');
      return {
        headline: text ? `added "${text}" to checklist` : 'added checklist item',
        details: [],
      };
    }

    case 'card.checklist_item_updated': {
      const fromRec = asRecord(diff.checklistItem?.from);
      const toRec = asRecord(diff.checklistItem?.to);
      const fromText = getStringField(fromRec, 'text');
      const toText = getStringField(toRec, 'text');
      if (
        fromRec &&
        toRec &&
        typeof fromRec.checked === 'boolean' &&
        fromRec.checked !== toRec.checked
      ) {
        const label = toText ?? fromText ?? 'item';
        return {
          headline: toRec.checked ? `checked "${label}"` : `unchecked "${label}"`,
          details: [],
        };
      }
      if (fromText && toText && fromText !== toText) {
        return {
          headline: `renamed checklist item "${fromText}" to "${toText}"`,
          details: [],
        };
      }
      return {
        headline: toText ? `updated checklist item "${toText}"` : 'updated checklist item',
        details: [],
      };
    }

    case 'card.checklist_item_deleted': {
      const text = getStringField(diff.checklistItem?.from, 'text');
      return {
        headline: text ? `removed "${text}" from checklist` : 'removed checklist item',
        details: [],
      };
    }

    case 'card.link_added': {
      const label = getStringField(diff.link?.to, 'label') ?? getStringField(diff.link?.to, 'url');
      return {
        headline: label ? `added link "${label}"` : 'added a link',
        details: [],
      };
    }

    case 'card.link_removed': {
      const label =
        getStringField(diff.link?.from, 'label') ?? getStringField(diff.link?.from, 'url');
      return {
        headline: label ? `removed link "${label}"` : 'removed a link',
        details: [],
      };
    }

    case 'card.attachment_added': {
      const fileName = getStringField(diff.attachment?.to, 'fileName');
      return {
        headline: fileName ? `attached "${fileName}"` : 'added an attachment',
        details: [],
      };
    }

    case 'card.attachment_renamed': {
      const fromName = getStringField(diff.attachment?.from, 'fileName');
      const toName = getStringField(diff.attachment?.to, 'fileName');
      return {
        headline:
          fromName && toName
            ? `renamed attachment "${fromName}" to "${toName}"`
            : 'renamed an attachment',
        details: [],
      };
    }

    case 'card.attachment_deleted': {
      const fileName = getStringField(diff.attachment?.from, 'fileName');
      return {
        headline: fileName ? `removed attachment "${fileName}"` : 'removed an attachment',
        details: [],
      };
    }

    case 'card.updated': {
      const hasAssignmentDiff = 'assignedUserIds' in diff || 'awareUserIds' in diff;
      const details: string[] = [];
      for (const [key, fieldDiff] of Object.entries(diff)) {
        if (key === 'visibleToUserIds' && hasAssignmentDiff) {
          continue;
        }
        details.push(formatUpdatedFieldDiff(key, fieldDiff.from, fieldDiff.to, usersById));
      }
      return { headline: 'updated this card', details };
    }

    default: {
      const unsupported: never = entry.action;
      throw new Error(`Unsupported activity action: ${String(unsupported)}`);
    }
  }
}
