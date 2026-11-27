import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../config.js';
import { listTagsHandler, renameTagHandler } from '../handlers/tags.js';
import { AppError } from '../lib/errors.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { normalizeIdempotencyKey } from '../services/idempotency.js';
import type { AuthContext } from '../types/express.js';

function requireReqAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return req.auth;
}

export function createTagsRouter(configOverride?: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(
    configOverride ? { getConfigFn: () => configOverride } : undefined,
  );

  router.get('/tags', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await listTagsHandler(auth, req.query);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post('/tags/rename', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const idempotencyKey = normalizeIdempotencyKey(req.header('idempotency-key'));
        const result = await renameTagHandler(auth, req.body, { idempotencyKey });
        if (result.replayed) {
          res.setHeader('X-Idempotent-Replay', 'true');
        }
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
