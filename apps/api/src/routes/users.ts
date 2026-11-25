import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  CreateUserInputSchema,
  UserSchema,
  type CreateUserInput,
  type User,
} from '@agent-kanban/shared';
import type { AppConfig } from '../config.js';
import { AppError, parseWithSchema } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';
import { createAuthMiddleware, requireAdmin, requireHumanAuth } from '../middleware/auth.js';

function parseStoredUser(id: string, rawData: Record<string, unknown>): User {
  const parsed = UserSchema.safeParse({
    ...rawData,
    id,
  });
  if (!parsed.success) {
    throw new AppError(500, 'INVALID_USER_RECORD', `Invalid user document "${id}"`);
  }
  return parsed.data;
}

export function createUsersRouter(configOverride?: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(
    configOverride ? { getConfigFn: () => configOverride } : undefined,
  );

  /**
   * GET /api/me — Returns the currently authenticated household user.
   */
  router.get('/me', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const auth = req.auth;
        if (!auth) {
          throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
        }

        const snap = await getDb().collection('users').doc(auth.userId).get();
        if (!snap.exists) {
          throw new AppError(404, 'USER_NOT_FOUND', 'Authenticated user record not found');
        }

        const user = parseStoredUser(snap.id, snap.data() ?? {});
        res.status(200).json({ user });
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * GET /api/users — Returns the household user roster for assignee/aware/@mention pickers.
   */
  router.get('/users', requireAuth, (_req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const snap = await getDb().collection('users').get();
        const users = snap.docs
          .map((doc) => parseStoredUser(doc.id, doc.data()))
          .sort((a, b) => {
            const byCreated = a.createdAt.localeCompare(b.createdAt);
            return byCreated !== 0 ? byCreated : a.displayName.localeCompare(b.displayName);
          });

        res.status(200).json({ users });
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * POST /api/admin/users — Admin-only endpoint to add a household user to the allowlist.
   */
  router.post(
    '/admin/users',
    requireAuth,
    requireHumanAuth,
    requireAdmin,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const input: CreateUserInput = parseWithSchema(
            CreateUserInputSchema,
            req.body,
            'Invalid user creation payload',
          );

          const db = getDb();
          const usersRef = db.collection('users');

          const [byEmail, byHandle] = await Promise.all([
            usersRef.where('email', '==', input.email).limit(1).get(),
            usersRef.where('handle', '==', input.handle).limit(1).get(),
          ]);

          if (!byEmail.empty) {
            throw new AppError(
              409,
              'USER_EMAIL_EXISTS',
              `A household user with email "${input.email}" already exists`,
            );
          }

          if (!byHandle.empty) {
            throw new AppError(
              409,
              'USER_HANDLE_EXISTS',
              `A household user with handle "@${input.handle}" already exists`,
            );
          }

          const userId = `user-${crypto.randomUUID()}`;
          const newUser: User = UserSchema.parse({
            id: userId,
            workosUserId: null,
            email: input.email,
            displayName: input.displayName,
            handle: input.handle,
            role: input.role,
            createdAt: new Date().toISOString(),
          });

          await usersRef.doc(userId).set(newUser);
          res.status(201).json({ user: newUser });
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  return router;
}
