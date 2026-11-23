import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { UserSchema, type User } from '@agent-kanban/shared';
import { z } from 'zod';
import { assertEmulatorAuthAllowed, getConfig, type AppConfig } from '../config.js';
import { signEmulatorToken } from '../lib/emulatorAuth.js';
import { AppError, parseWithSchema } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';

const DevTokenRequestSchema = z
  .object({
    userId: z.string().trim().min(1).optional(),
    email: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase())
      .optional(),
    handle: z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.replace(/^@/, '').toLowerCase())
      .optional(),
    sub: z.string().trim().min(1).optional(),
    emailVerified: z.boolean().optional().default(true),
    allowUnregistered: z.boolean().optional().default(false),
  })
  .refine((data) => Boolean(data.userId || data.email || data.handle), {
    message: 'Provide at least one of userId, email, or handle',
  });

async function findSeededUser(input: {
  userId?: string;
  email?: string;
  handle?: string;
}): Promise<User | null> {
  const usersRef = getDb().collection('users');

  if (input.userId) {
    const snap = await usersRef.doc(input.userId).get();
    if (!snap.exists) {
      return null;
    }
    return UserSchema.parse({ ...(snap.data() ?? {}), id: snap.id });
  }

  if (input.email) {
    const snap = await usersRef.where('email', '==', input.email).limit(1).get();
    const doc = snap.docs[0];
    if (!doc) {
      return null;
    }
    return UserSchema.parse({ ...doc.data(), id: doc.id });
  }

  if (input.handle) {
    const snap = await usersRef.where('handle', '==', input.handle).limit(1).get();
    const doc = snap.docs[0];
    if (!doc) {
      return null;
    }
    return UserSchema.parse({ ...doc.data(), id: doc.id });
  }

  return null;
}

/**
 * Mounts emulator-only token issuance (`POST /api/dev/token`) strictly after
 * verifying `assertEmulatorAuthAllowed`. Never mounted in WorkOS/production mode.
 */
export function createDevAuthRouter(config: AppConfig = getConfig()): Router {
  assertEmulatorAuthAllowed(config);
  if (config.authMode !== 'emulator') {
    throw new Error('Dev auth router can only be created when AUTH_MODE=emulator');
  }

  const router = Router();

  router.post('/dev/token', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const liveConfig = getConfig();
        assertEmulatorAuthAllowed(liveConfig);

        const input = parseWithSchema(
          DevTokenRequestSchema,
          req.body,
          'Invalid dev token request payload',
        );

        if (input.allowUnregistered) {
          if (!input.email) {
            throw new AppError(
              400,
              'VALIDATION_ERROR',
              'email is required when allowUnregistered is true',
            );
          }

          const sub = input.sub ?? `workos_emu_${crypto.randomUUID()}`;
          const token = await signEmulatorToken(
            {
              sub,
              email: input.email,
              emailVerified: input.emailVerified,
            },
            liveConfig,
          );

          res.status(200).json({
            token,
            expiresIn: 3600,
            claims: {
              sub,
              email: input.email,
              email_verified: input.emailVerified,
            },
          });
          return;
        }

        const user = await findSeededUser({
          userId: input.userId,
          email: input.email,
          handle: input.handle,
        });

        if (!user) {
          throw new AppError(
            404,
            'USER_NOT_FOUND',
            'Requested emulator user was not found in Firestore',
          );
        }

        const sub = input.sub ?? user.workosUserId ?? `workos_emu_${user.id}`;
        const token = await signEmulatorToken(
          {
            sub,
            email: user.email,
            emailVerified: input.emailVerified,
            name: user.displayName,
          },
          liveConfig,
        );

        res.status(200).json({
          token,
          expiresIn: 3600,
          user,
          claims: {
            sub,
            email: user.email,
            email_verified: input.emailVerified,
          },
        });
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
