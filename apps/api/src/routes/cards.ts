import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../config.js';
import {
  archiveCardHandler,
  changeCardStatusHandler,
  createCardHandler,
  getCardByIdHandler,
  getCardByTrelloHandler,
  listCardActivityHandler,
  listCardsHandler,
  listGlobalActivityHandler,
  updateCardHandler,
} from '../handlers/cards.js';
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

export function createCardsRouter(configOverride?: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(
    configOverride ? { getConfigFn: () => configOverride } : undefined,
  );

  router.post('/cards', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const idempotencyKey = normalizeIdempotencyKey(req.header('idempotency-key'));
        const result = await createCardHandler(auth, req.body, { idempotencyKey });
        if (result.replayed) {
          res.setHeader('X-Idempotent-Replay', 'true');
        }
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get('/cards', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await listCardsHandler(auth, req.query);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  // Registered before /cards/:id so "by-trello" is not captured as a card ID.
  router.get('/cards/by-trello', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await getCardByTrelloHandler(auth, req.query);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get('/cards/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await getCardByIdHandler(auth, req.params.id);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.patch('/cards/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await updateCardHandler(auth, req.params.id, req.body);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post(
    '/cards/:id/status',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await changeCardStatusHandler(auth, req.params.id, req.body);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.post(
    '/cards/:id/archive',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await archiveCardHandler(auth, req.params.id, req.body);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.get(
    '/cards/:id/activity',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await listCardActivityHandler(auth, req.params.id, req.query);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.get('/activity', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await listGlobalActivityHandler(auth, req.query);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
