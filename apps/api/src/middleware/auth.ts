import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { UserSchema, type User } from '@agent-kanban/shared';
import { assertEmulatorAuthAllowed, getConfig, type AppConfig } from '../config.js';
import { constantTimeEqualHex, hashApiKey, isApiKeyToken } from '../lib/apiKeys.js';
import { verifyEmulatorToken } from '../lib/emulatorAuth.js';
import { AppError } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';
import type { AuthContext } from '../types/express.js';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getWorkosJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUrl);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, jwks);
  }
  return jwks;
}

export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (authorizationHeader === undefined) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing Authorization header');
  }

  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  if (!match || !match[1]) {
    throw new AppError(401, 'UNAUTHORIZED', 'Malformed Authorization header');
  }

  return match[1];
}

export interface VerifiedJwtIdentity {
  workosUserId: string;
  email: string | null;
  emailVerified: boolean;
}

export async function verifyJwt(
  token: string,
  config: AppConfig = getConfig(),
): Promise<VerifiedJwtIdentity> {
  assertEmulatorAuthAllowed(config);

  let payload: JWTPayload;
  try {
    if (config.authMode === 'emulator') {
      payload = await verifyEmulatorToken(token, config);
    } else {
      if (!config.workosJwksUrl) {
        throw new AppError(
          500,
          'AUTH_MISCONFIGURED',
          'WORKOS_JWKS_URL is not configured for WorkOS authentication mode',
        );
      }
      const jwks = getWorkosJwks(config.workosJwksUrl);
      const result = await jwtVerify(token, jwks, {
        ...(config.workosIssuer ? { issuer: config.workosIssuer } : {}),
      });
      payload = result.payload;
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired authentication token');
  }

  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (sub.length === 0) {
    throw new AppError(401, 'INVALID_TOKEN', 'Authentication token is missing subject claim');
  }

  const emailVerified = payload.email_verified !== false;
  const rawEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
  const email = rawEmail && rawEmail.length > 0 ? rawEmail : null;

  return {
    workosUserId: sub,
    email,
    emailVerified,
  };
}

function parseUserDocument(id: string, rawData: Record<string, unknown>): User {
  const parsed = UserSchema.safeParse({
    ...rawData,
    id,
  });
  if (!parsed.success) {
    throw new AppError(500, 'INVALID_USER_RECORD', 'Stored user record failed schema validation');
  }
  return parsed.data;
}

/**
 * Resolves an authenticated JWT identity against the Firestore `users` allowlist.
 * 1. Looks up by `workosUserId` first.
 * 2. Falls back to lowercased verified `email`; if matched and `workosUserId` is null,
 *    atomically links `workosUserId` in a Firestore transaction.
 * 3. Rejects unknown accounts with 403 (`USER_NOT_ALLOWLISTED`).
 */
export async function resolveAllowlistedUser(
  identity: VerifiedJwtIdentity,
  db: Firestore = getDb(),
): Promise<User> {
  const usersRef = db.collection('users');

  const byWorkosSnap = await usersRef
    .where('workosUserId', '==', identity.workosUserId)
    .limit(1)
    .get();

  const existingByWorkos = byWorkosSnap.docs[0];
  if (existingByWorkos) {
    return parseUserDocument(existingByWorkos.id, existingByWorkos.data());
  }

  if (!identity.emailVerified) {
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verified email address is required');
  }

  if (!identity.email) {
    throw new AppError(
      403,
      'USER_NOT_ALLOWLISTED',
      'Your account is not allowlisted for this household',
    );
  }

  const byEmailSnap = await usersRef.where('email', '==', identity.email).limit(1).get();
  const matchedByEmail = byEmailSnap.docs[0];
  if (!matchedByEmail) {
    throw new AppError(
      403,
      'USER_NOT_ALLOWLISTED',
      'Your account is not allowlisted for this household',
    );
  }

  const userRef = matchedByEmail.ref;

  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(userRef);
    if (!freshSnap.exists) {
      throw new AppError(
        403,
        'USER_NOT_ALLOWLISTED',
        'Your account is not allowlisted for this household',
      );
    }

    const freshData = freshSnap.data() ?? {};
    const currentWorkosId = freshData.workosUserId as string | null | undefined;

    if (currentWorkosId === null || currentWorkosId === undefined) {
      tx.update(userRef, { workosUserId: identity.workosUserId });
      return parseUserDocument(freshSnap.id, {
        ...freshData,
        workosUserId: identity.workosUserId,
      });
    }

    if (currentWorkosId === identity.workosUserId) {
      return parseUserDocument(freshSnap.id, freshData);
    }

    throw new AppError(
      403,
      'USER_IDENTITY_MISMATCH',
      'Account email is already linked to a different identity',
    );
  });
}

export interface AuthMiddlewareOptions {
  getConfigFn?: () => AppConfig;
  getDbFn?: () => Firestore;
}

const MAX_AGENT_NAME_LENGTH = 120;

export async function authenticateApiKey(
  token: string,
  rawAgentNameHeader: string | undefined,
  db: Firestore = getDb(),
): Promise<AuthContext> {
  const candidateHash = hashApiKey(token);
  const connSnap = await db
    .collection('agentConnections')
    .where('hashedKey', '==', candidateHash)
    .limit(1)
    .get();

  const connDoc = connSnap.docs[0];
  if (!connDoc) {
    throw new AppError(401, 'INVALID_API_KEY', 'Invalid or revoked API key');
  }

  const connData = connDoc.data();
  const storedHash = typeof connData.hashedKey === 'string' ? connData.hashedKey : '';
  const revoked = connData.revoked === true;
  if (revoked || !constantTimeEqualHex(storedHash, candidateHash)) {
    throw new AppError(401, 'INVALID_API_KEY', 'Invalid or revoked API key');
  }

  const ownerUserId = typeof connData.ownerUserId === 'string' ? connData.ownerUserId : '';
  const platform = typeof connData.platform === 'string' ? connData.platform.trim() : '';
  if (!ownerUserId || !platform) {
    throw new AppError(401, 'INVALID_API_KEY', 'Invalid or revoked API key');
  }

  const ownerSnap = await db.collection('users').doc(ownerUserId).get();
  if (!ownerSnap.exists) {
    throw new AppError(401, 'INVALID_API_KEY', 'Invalid or revoked API key');
  }
  const owner = parseUserDocument(ownerSnap.id, ownerSnap.data() ?? {});

  const trimmedAgentName = rawAgentNameHeader?.trim() ?? '';
  const agentName =
    trimmedAgentName.length > 0
      ? trimmedAgentName.slice(0, MAX_AGENT_NAME_LENGTH)
      : platform.slice(0, MAX_AGENT_NAME_LENGTH);

  return {
    userId: owner.id,
    ownerUserId: owner.id,
    role: owner.role,
    actorType: 'agent',
    displayName: owner.displayName,
    handle: owner.handle,
    email: owner.email,
    workosUserId: owner.workosUserId,
    connectionId: connDoc.id,
    platform,
    agentName,
  };
}

export function createAuthMiddleware(options: AuthMiddlewareOptions = {}): RequestHandler {
  const getConfigFn = options.getConfigFn ?? getConfig;
  const getDbFn = options.getDbFn ?? getDb;

  // Enforce hard safety guard immediately when wiring middleware.
  assertEmulatorAuthAllowed(getConfigFn());

  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const config = getConfigFn();
        const token = extractBearerToken(req.header('authorization'));

        if (isApiKeyToken(token)) {
          req.auth = await authenticateApiKey(token, req.header('x-agent-name'), getDbFn());
          next();
          return;
        }

        const identity = await verifyJwt(token, config);
        const user = await resolveAllowlistedUser(identity, getDbFn());

        req.auth = {
          userId: user.id,
          ownerUserId: user.id,
          role: user.role,
          actorType: 'human',
          displayName: user.displayName,
          handle: user.handle,
          email: user.email,
          workosUserId: user.workosUserId,
        };

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

export const requireHumanAuth: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (!req.auth) {
    next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    return;
  }
  if (req.auth.actorType !== 'human') {
    next(new AppError(403, 'FORBIDDEN', 'Human authentication required'));
    return;
  }
  next();
};

export const requireAdmin: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (!req.auth) {
    next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    return;
  }
  if (req.auth.role !== 'admin') {
    next(new AppError(403, 'FORBIDDEN', 'Admin role required'));
    return;
  }
  next();
};
