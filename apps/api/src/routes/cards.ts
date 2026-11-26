import { Router, type NextFunction, type Request, type Response } from 'express';
import { getConfig, type AppConfig } from '../config.js';
import {
  confirmAttachmentUploadHandler,
  createAttachmentUploadUrlHandler,
  deleteCardAttachmentHandler,
  getAttachmentDownloadUrlHandler,
  listCardAttachmentsHandler,
  renameCardAttachmentHandler,
  resolveEmulatorApiBaseUrl,
} from '../handlers/attachments.js';
import {
  archiveCardHandler,
  changeCardStatusHandler,
  completeCardHandler,
  createCardHandler,
  getCardByIdHandler,
  getCardByTrelloHandler,
  listCardActivityHandler,
  listCardsHandler,
  listGlobalActivityHandler,
  searchCardsHandler,
  updateCardHandler,
} from '../handlers/cards.js';
import {
  addCardLinkHandler,
  addChecklistItemHandler,
  createChecklistHandler,
  deleteCardLinkHandler,
  deleteChecklistHandler,
  deleteChecklistItemHandler,
  updateChecklistHandler,
  updateChecklistItemHandler,
} from '../handlers/checklists.js';
import { createCardCommentHandler, listCardCommentsHandler } from '../handlers/comments.js';
import {
  bulkUpdateCardsHandler,
  bulkUpdatePrioritiesHandler,
  smartQueryCardsHandler,
  workspaceSnapshotHandler,
} from '../handlers/priorities.js';
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

  // Registered before /cards/:id so "by-trello" and "search" are not captured as card IDs.
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

  router.get('/cards/search', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const result = await searchCardsHandler(auth, req.query);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get('/cards/smart', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const householdTimezone = (configOverride ?? getConfig()).householdTimezone;
        const result = await smartQueryCardsHandler(auth, req.query, { householdTimezone });
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.patch(
    '/cards/priorities',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const idempotencyKey = normalizeIdempotencyKey(req.header('idempotency-key'));
          const result = await bulkUpdatePrioritiesHandler(auth, req.body, { idempotencyKey });
          if (result.replayed) {
            res.setHeader('X-Idempotent-Replay', 'true');
          }
          res.status(result.status).json(result.body);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.patch('/cards/bulk', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = requireReqAuth(req);
        const idempotencyKey = normalizeIdempotencyKey(req.header('idempotency-key'));
        const result = await bulkUpdateCardsHandler(auth, req.body, { idempotencyKey });
        if (result.replayed) {
          res.setHeader('X-Idempotent-Replay', 'true');
        }
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get(
    '/workspace/snapshot',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const householdTimezone = (configOverride ?? getConfig()).householdTimezone;
          const result = await workspaceSnapshotHandler(auth, { householdTimezone });
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

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

  router.post(
    '/cards/:id/complete',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const householdTimezone = (configOverride ?? getConfig()).householdTimezone;
          const result = await completeCardHandler(auth, req.params.id, req.body, {
            householdTimezone,
          });
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.get(
    '/cards/:id/comments',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await listCardCommentsHandler(auth, req.params.id);
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.post(
    '/cards/:id/comments',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await createCardCommentHandler(auth, req.params.id, req.body);
          res.status(201).json(result);
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

  router.post(
    '/cards/:id/checklists',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await createChecklistHandler(auth, req.params.id, req.body);
          res.status(201).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.patch(
    '/cards/:id/checklists/:checklistId',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await updateChecklistHandler(
            auth,
            req.params.id,
            req.params.checklistId,
            req.body,
          );
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.delete(
    '/cards/:id/checklists/:checklistId',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await deleteChecklistHandler(
            auth,
            req.params.id,
            req.params.checklistId,
            req.body,
          );
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.post(
    '/cards/:id/checklists/:checklistId/items',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await addChecklistItemHandler(
            auth,
            req.params.id,
            req.params.checklistId,
            req.body,
          );
          res.status(201).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.patch(
    '/cards/:id/checklists/:checklistId/items/:itemId',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await updateChecklistItemHandler(
            auth,
            req.params.id,
            req.params.checklistId,
            req.params.itemId,
            req.body,
          );
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.delete(
    '/cards/:id/checklists/:checklistId/items/:itemId',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await deleteChecklistItemHandler(
            auth,
            req.params.id,
            req.params.checklistId,
            req.params.itemId,
            req.body,
          );
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.post(
    '/cards/:id/links',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await addCardLinkHandler(auth, req.params.id, req.body);
          res.status(201).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.delete(
    '/cards/:id/links/:linkId',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await deleteCardLinkHandler(
            auth,
            req.params.id,
            req.params.linkId,
            req.body,
          );
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

  router.post(
    '/cards/:id/attachments/upload-url',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await createAttachmentUploadUrlHandler(auth, req.params.id, req.body, {
            ...(configOverride ? { config: configOverride } : {}),
            emulatorBaseUrl: resolveEmulatorApiBaseUrl(req),
          });
          res.status(201).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.post(
    '/cards/:id/attachments/:attachmentId/confirm',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await confirmAttachmentUploadHandler(
            auth,
            req.params.id,
            req.params.attachmentId,
            configOverride ? { config: configOverride } : undefined,
          );
          res.status(201).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.get(
    '/cards/:id/attachments',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await listCardAttachmentsHandler(
            auth,
            req.params.id,
            configOverride ? { config: configOverride } : undefined,
          );
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.get(
    '/cards/:id/attachments/:attachmentId/download-url',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await getAttachmentDownloadUrlHandler(
            auth,
            req.params.id,
            req.params.attachmentId,
            {
              ...(configOverride ? { config: configOverride } : {}),
              emulatorBaseUrl: resolveEmulatorApiBaseUrl(req),
            },
          );
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.patch(
    '/cards/:id/attachments/:attachmentId',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await renameCardAttachmentHandler(
            auth,
            req.params.id,
            req.params.attachmentId,
            req.body,
            configOverride ? { config: configOverride } : undefined,
          );
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.delete(
    '/cards/:id/attachments/:attachmentId',
    requireAuth,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const auth = requireReqAuth(req);
          const result = await deleteCardAttachmentHandler(
            auth,
            req.params.id,
            req.params.attachmentId,
            configOverride ? { config: configOverride } : undefined,
          );
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  return router;
}
