export const APP_NAME = 'agent-kanban' as const;

export const SHARED_VERSION = '0.0.1' as const;

export function formatServiceBanner(service: string): string {
  return `${APP_NAME}:${service}@${SHARED_VERSION}`;
}
