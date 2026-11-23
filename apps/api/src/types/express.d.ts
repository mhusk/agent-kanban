import type { ActorType, UserRole } from '@agent-kanban/shared';

export interface AuthContext {
  userId: string;
  ownerUserId: string;
  role: UserRole;
  actorType: ActorType;
  displayName: string;
  handle: string;
  email: string;
  workosUserId: string | null;
  agentName?: string;
  platform?: string;
  connectionId?: string;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
    }
  }
}

export {};
