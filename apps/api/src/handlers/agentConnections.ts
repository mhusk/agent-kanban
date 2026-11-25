import crypto from 'node:crypto';
import {
  AgentConnectionSchema,
  CreateAgentConnectionSchema,
  EntityIdSchema,
  type AgentConnection,
} from '@agent-kanban/shared';
import { generateApiKey } from '../lib/apiKeys.js';
import { AppError, parseWithSchema } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';
import type { AuthContext } from '../types/express.js';
import type { HandlerDeps } from './cards.js';

export function toPublicAgentConnection(
  id: string,
  rawData: Record<string, unknown>,
): AgentConnection {
  const { hashedKey: _ignored, ...rest } = rawData;
  const parsed = AgentConnectionSchema.safeParse({
    ...rest,
    id,
  });
  if (!parsed.success) {
    throw new AppError(
      500,
      'INVALID_CONNECTION_RECORD',
      `Stored agent connection "${id}" failed schema validation`,
    );
  }
  return parsed.data;
}

export async function listAgentConnectionsHandler(
  auth: AuthContext,
  deps: HandlerDeps = {},
): Promise<{ connections: AgentConnection[] }> {
  const db = deps.db ?? getDb();
  const snap = await db
    .collection('agentConnections')
    .where('ownerUserId', '==', auth.userId)
    .get();

  const connections = snap.docs
    .map((doc) => toPublicAgentConnection(doc.id, doc.data()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { connections };
}

export async function createAgentConnectionHandler(
  auth: AuthContext,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ connection: AgentConnection; apiKey: string }> {
  const input = parseWithSchema(
    CreateAgentConnectionSchema,
    rawInput,
    'Invalid agent connection payload',
  );
  const db = deps.db ?? getDb();
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();

  const connectionId = `conn-${crypto.randomUUID()}`;
  const { fullKey, keyPrefix, hashedKey } = generateApiKey();

  const connection = AgentConnectionSchema.parse({
    id: connectionId,
    ownerUserId: auth.userId,
    platform: input.platform,
    authType: 'api_key',
    keyPrefix,
    revoked: false,
    rotatedAt: null,
    createdAt: nowIso,
  });

  await db
    .collection('agentConnections')
    .doc(connectionId)
    .set({
      ...connection,
      hashedKey,
    });

  return {
    connection,
    apiKey: fullKey,
  };
}

export async function rotateAgentConnectionHandler(
  auth: AuthContext,
  rawConnectionId: unknown,
  deps: HandlerDeps = {},
): Promise<{ connection: AgentConnection; apiKey: string }> {
  const connectionId = parseWithSchema(EntityIdSchema, rawConnectionId, 'Invalid connection ID');
  const db = deps.db ?? getDb();
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const connRef = db.collection('agentConnections').doc(connectionId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(connRef);
    const data = snap.exists ? (snap.data() ?? {}) : null;
    if (!data || data.ownerUserId !== auth.userId) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Agent connection not found');
    }

    const existing = toPublicAgentConnection(snap.id, data);
    if (existing.revoked) {
      throw new AppError(400, 'CONNECTION_REVOKED', 'Cannot rotate a revoked agent connection');
    }

    const { fullKey, keyPrefix, hashedKey } = generateApiKey();
    const updated = AgentConnectionSchema.parse({
      ...existing,
      keyPrefix,
      rotatedAt: nowIso,
    });

    tx.update(connRef, {
      keyPrefix,
      hashedKey,
      rotatedAt: nowIso,
    });

    return {
      connection: updated,
      apiKey: fullKey,
    };
  });
}

export async function revokeAgentConnectionHandler(
  auth: AuthContext,
  rawConnectionId: unknown,
  deps: HandlerDeps = {},
): Promise<{ connection: AgentConnection }> {
  const connectionId = parseWithSchema(EntityIdSchema, rawConnectionId, 'Invalid connection ID');
  const db = deps.db ?? getDb();
  const connRef = db.collection('agentConnections').doc(connectionId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(connRef);
    const data = snap.exists ? (snap.data() ?? {}) : null;
    if (!data || data.ownerUserId !== auth.userId) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Agent connection not found');
    }

    const existing = toPublicAgentConnection(snap.id, data);
    const updated = AgentConnectionSchema.parse({
      ...existing,
      revoked: true,
    });

    if (!existing.revoked) {
      tx.update(connRef, { revoked: true });
    }

    return { connection: updated };
  });
}
