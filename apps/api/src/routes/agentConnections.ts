import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../config.js';
import {
  createAgentConnectionHandler,
  listAgentConnectionsHandler,
  revokeAgentConnectionHandler,
  rotateAgentConnectionHandler,
  updateAgentConnectionHandler,
} from '../handlers/agentConnections.js';
import { AppError } from '../lib/errors.js';
import { createAuthMiddleware, requireHumanAuth } from '../middleware/auth.js';
import type { AuthContext } from '../types/express.js';

function requireReqAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return req.auth;
}

export function createAgentConnectionsRouter(configOverride?: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(
    configOverride ? { getConfigFn: () => configOverride } : undefined,
  );

  router.get(
    '/agent-connections',
    requireAuth,
    requireHumanAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await listAgentConnectionsHandler(auth);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.post(
    '/agent-connections',
    requireAuth,
    requireHumanAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await createAgentConnectionHandler(auth, req.body);
          res.status(201).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.patch(
    '/agent-connections/:id',
    requireAuth,
    requireHumanAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await updateAgentConnectionHandler(auth, req.params.id, req.body);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.post(
    '/agent-connections/:id/rotate',
    requireAuth,
    requireHumanAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await rotateAgentConnectionHandler(auth, req.params.id);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.delete(
    '/agent-connections/:id',
    requireAuth,
    requireHumanAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await revokeAgentConnectionHandler(auth, req.params.id);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  return router;
}
