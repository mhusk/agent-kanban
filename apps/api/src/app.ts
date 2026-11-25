import crypto from 'node:crypto';
import express, {
  type Application,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { APP_NAME, SHARED_VERSION } from '@agent-kanban/shared';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { assertEmulatorAuthAllowed, getConfig, type AppConfig } from './config.js';
import {
  handleEmulatorStorageGet,
  handleEmulatorStoragePut,
  isStorageEmulatorTransferEnabled,
} from './handlers/attachments.js';
import { AppError, parseWithSchema, type ErrorResponseBody } from './lib/errors.js';
import { createAgentConnectionsRouter } from './routes/agentConnections.js';
import { createCardsRouter } from './routes/cards.js';
import { createDevAuthRouter } from './routes/devAuth.js';
import { createEventsRouter } from './routes/events.js';
import { createMcpRouter } from './routes/mcp.js';
import { createSubscriptionsRouter } from './routes/subscriptions.js';
import { createUsersRouter } from './routes/users.js';

export { AppError, parseWithSchema };
export type { ErrorResponseBody };

const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function resolveRequestId(rawHeader: string | undefined): string {
  if (
    rawHeader !== undefined &&
    rawHeader.length > 0 &&
    rawHeader.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID_PATTERN.test(rawHeader)
  ) {
    return rawHeader;
  }
  return crypto.randomUUID();
}

export const requestIdMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const headerVal = req.header('x-request-id');
  const requestId = resolveRequestId(headerVal);
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};

export interface RequestValidationSchemas<TBody = unknown, TQuery = unknown, TParams = unknown> {
  body?: ZodType<TBody, ZodTypeDef, unknown>;
  query?: ZodType<TQuery, ZodTypeDef, unknown>;
  params?: ZodType<TParams, ZodTypeDef, unknown>;
}

export function validateRequest<TBody = unknown, TQuery = unknown, TParams = unknown>(
  schemas: RequestValidationSchemas<TBody, TQuery, TParams>,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) {
        req.params = parseWithSchema(
          schemas.params,
          req.params,
          'Invalid route parameters',
        ) as Request['params'];
      }
      if (schemas.query) {
        req.query = parseWithSchema(
          schemas.query,
          req.query,
          'Invalid query parameters',
        ) as Request['query'];
      }
      if (schemas.body) {
        req.body = parseWithSchema(schemas.body, req.body, 'Invalid request body');
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return err instanceof Error && typeof (err as BodyParserError).type === 'string';
}

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    const body: ErrorResponseBody = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  if (err instanceof ZodError) {
    const body: ErrorResponseBody = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.flatten(),
      },
    };
    res.status(400).json(body);
    return;
  }

  if (isBodyParserError(err)) {
    if (err.type === 'entity.too.large') {
      const body: ErrorResponseBody = {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body exceeds the 1 MB limit',
        },
      };
      res.status(413).json(body);
      return;
    }
    if (err.type === 'entity.parse.failed') {
      const body: ErrorResponseBody = {
        error: {
          code: 'INVALID_JSON',
          message: 'Malformed JSON request body',
        },
      };
      res.status(400).json(body);
      return;
    }
  }

  console.error(`[${req.requestId ?? 'unknown'}] Unhandled API error:`, err);
  const body: ErrorResponseBody = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  };
  res.status(500).json(body);
};

export function createApp(configOverride?: AppConfig): Application {
  const config = configOverride ?? getConfig();
  assertEmulatorAuthAllowed(config);

  const app = express();

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);

  if (isStorageEmulatorTransferEnabled(config)) {
    app.put(
      '/api/emulator/storage',
      express.raw({ type: '*/*', limit: '15mb' }),
      (req: Request, res: Response, next: NextFunction) => {
        void handleEmulatorStoragePut(req, res, configOverride).catch(next);
      },
    );
    app.get('/api/emulator/storage', (req: Request, res: Response, next: NextFunction) => {
      void handleEmulatorStorageGet(req, res, configOverride).catch(next);
    });
  }

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      service: APP_NAME,
      timestamp: new Date().toISOString(),
      version: SHARED_VERSION,
    });
  });

  if (config.authMode === 'emulator') {
    app.use('/api', createDevAuthRouter(config));
  }

  app.use('/api', createUsersRouter(configOverride));
  app.use('/api', createAgentConnectionsRouter(configOverride));
  app.use('/api', createCardsRouter(configOverride));
  app.use('/api', createEventsRouter(configOverride));
  app.use('/api', createSubscriptionsRouter(configOverride));
  app.use(createMcpRouter(configOverride));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(new AppError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
  });

  app.use(errorHandler);

  return app;
}
