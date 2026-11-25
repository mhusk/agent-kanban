import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../config.js';
import {
  createSubscriptionHandler,
  deleteSubscriptionHandler,
  listSubscriptionsHandler,
  updateSubscriptionHandler,
} from '../handlers/subscriptions.js';
import { AppError } from '../lib/errors.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { AuthContext } from '../types/express.js';

function requireReqAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return req.auth;
}

export function createSubscriptionsRouter(configOverride?: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(
    configOverride ? { getConfigFn: () => configOverride } : undefined,
  );
  const deps = configOverride ? { config: configOverride } : undefined;

  router.get('/subscriptions', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await listSubscriptionsHandler(auth, deps);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post('/subscriptions', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await createSubscriptionHandler(auth, req.body, deps);
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.patch(
    '/subscriptions/:id',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await updateSubscriptionHandler(auth, req.params.id, req.body, deps);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.delete(
    '/subscriptions/:id',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await deleteSubscriptionHandler(auth, req.params.id, deps);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  return router;
}
