import type { IncomingMessage } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getConfig, type AppConfig } from '../config.js';
import { EMULATOR_JWT_ISSUER } from '../lib/emulatorAuth.js';
import { AppError } from '../lib/errors.js';
import { createMcpServer } from '../mcp/server.js';
import { createAuthMiddleware } from '../middleware/auth.js';

function firstHeaderValue(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const first = raw.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export function resolvePublicOrigin(req: Request): string {
  const proto = firstHeaderValue(req.header('x-forwarded-proto')) ?? req.protocol ?? 'http';
  const host =
    firstHeaderValue(req.header('x-forwarded-host')) ??
    firstHeaderValue(req.header('host')) ??
    '127.0.0.1';
  return `${proto}://${host}`;
}

export function createMcpRouter(configOverride?: AppConfig): Router {
  const router = Router();
  const baseAuthMiddleware = createAuthMiddleware(
    configOverride ? { getConfigFn: () => configOverride } : undefined,
  );

  const buildProtectedResourceMetadata = (req: Request) => {
    const config = configOverride ?? getConfig();
    const origin = resolvePublicOrigin(req);
    const authorizationServer = config.workosIssuer ?? EMULATOR_JWT_ISSUER;

    return {
      resource: `${origin}/mcp`,
      authorization_servers: [authorizationServer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'profile', 'email'],
    };
  };

  router.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    res.status(200).json(buildProtectedResourceMetadata(req));
  });

  router.get('/.well-known/oauth-protected-resource/mcp', (req: Request, res: Response) => {
    res.status(200).json(buildProtectedResourceMetadata(req));
  });

  const requireMcpAuth = (req: Request, res: Response, next: NextFunction): void => {
    baseAuthMiddleware(req, res, (err?: unknown) => {
      if (err instanceof AppError && err.statusCode === 401) {
        const origin = resolvePublicOrigin(req);
        res.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        );
      }
      next(err);
    });
  };

  router.post('/mcp', requireMcpAuth, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const auth = req.auth;
      if (!auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      }

      const config = configOverride ?? getConfig();
      const server = createMcpServer(auth, {
        headerAgentName: req.header('x-agent-name'),
        householdTimezone: config.householdTimezone,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req as unknown as IncomingMessage, res, req.body);
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        next(error);
      }
    });
  });

  const handleMethodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Stateless MCP endpoint accepts POST requests only',
      },
    });
  };

  router.get('/mcp', handleMethodNotAllowed);
  router.delete('/mcp', handleMethodNotAllowed);

  return router;
}
