import type { Card, User } from '@agent-kanban/shared';

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
    return `${entry.agentName ?? 'Agent'} via ${entry.platform ?? 'API'} (agent)`;
  }
  if (entry.actorType === 'system') {
    return 'System';
  }
  return usersById.get(entry.actorId)?.displayName ?? entry.actorId;
}
