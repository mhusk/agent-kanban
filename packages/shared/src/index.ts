export const APP_NAME = 'agent-kanban' as const;

export const SHARED_VERSION = '0.0.1' as const;

export function formatServiceBanner(service: string): string {
  return `${APP_NAME}:${service}@${SHARED_VERSION}`;
}

export * from './schemas/common.js';
export * from './schemas/user.js';
export * from './schemas/card.js';
export * from './schemas/activity.js';
export * from './schemas/comment.js';
export * from './schemas/attachment.js';
export * from './schemas/agent.js';
export * from './utils/search.js';
export * from './utils/mentions.js';
export * from './utils/dates.js';
export * from './utils/recurrence.js';
