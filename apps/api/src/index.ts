import { APP_NAME, formatServiceBanner } from '@agent-kanban/shared';

export const apiServiceInfo = {
  app: APP_NAME,
  banner: formatServiceBanner('api'),
} as const;
