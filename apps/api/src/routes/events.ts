import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../config.js';
import { listEventsHandler } from '../handlers/events.js';
import { AppError } from '../lib/errors.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { AuthContext } from '../types/express.js';

function requireReqAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return req.auth;
}

export function createEventsRouter(configOverride?: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(
    configOverride ? { getConfigFn: () => configOverride } : undefined,
  );

  router.get('/events', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await listEventsHandler(auth, req.query);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
