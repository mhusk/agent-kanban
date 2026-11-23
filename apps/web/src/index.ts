import { APP_NAME, formatServiceBanner } from '@agent-kanban/shared';

export const webAppInfo = {
  app: APP_NAME,
  banner: formatServiceBanner('web'),
} as const;
