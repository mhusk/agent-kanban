import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z, ZodError } from 'zod';
import {
  AppError,
  errorHandler,
  parseWithSchema,
  requestIdMiddleware,
  validateRequest,
} from '../app.js';
import { assertEmulatorAuthAllowed, readConfig } from '../config.js';

function createMockResponse() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let jsonBody: unknown = undefined;

  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      jsonBody = payload;
      this.headersSent = true;
      return this;
    },
  };

  return {
    res: res as unknown as Response,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  };
}

describe('API config & emulator auth guard', () => {
  it('uses safe defaults when environment variables are unset', () => {
    const config = readConfig({});
    expect(config).toEqual({
      authMode: 'workos',
      householdTimezone: 'UTC',
      autoArchiveDays: 30,
      workosClientId: null,
      workosJwksUrl: null,
      workosIssuer: null,
      webhookEncryptionKey: null,
      backupBucket: null,
      isEmulator: false,
      isTest: false,
    });
  });

  it('parses valid overrides', () => {
    const config = readConfig({
      AUTH_MODE: 'emulator',
      FUNCTIONS_EMULATOR: 'true',
      HOUSEHOLD_TIMEZONE: 'America/New_York',
      AUTO_ARCHIVE_DAYS: '45',
      WORKOS_CLIENT_ID: 'client_example_placeholder',
      WORKOS_JWKS_URL: 'https://api.workos.com/sso/jwks/client_example_placeholder',
      WORKOS_ISSUER: 'https://api.workos.com/user_management/client_example_placeholder',
      BACKUP_BUCKET: 'gs://example-agent-kanban-backups',
    });
    expect(config.authMode).toBe('emulator');
    expect(config.householdTimezone).toBe('America/New_York');
    expect(config.autoArchiveDays).toBe(45);
    expect(config.isEmulator).toBe(true);
    expect(config.backupBucket).toBe('gs://example-agent-kanban-backups');
  });

  it('throws when AUTH_MODE=emulator outside emulator and test environments', () => {
    expect(() =>
      readConfig({
        AUTH_MODE: 'emulator',
        NODE_ENV: 'production',
      }),
    ).toThrow(/AUTH_MODE=emulator is strictly prohibited/);

    expect(() =>
      assertEmulatorAuthAllowed({
        authMode: 'emulator',
        isEmulator: false,
        isTest: false,
      }),
    ).toThrow(/AUTH_MODE=emulator is strictly prohibited/);
  });

  it('allows AUTH_MODE=emulator when NODE_ENV=test', () => {
    const config = readConfig({
      AUTH_MODE: 'emulator',
      NODE_ENV: 'test',
    });
    expect(config.authMode).toBe('emulator');
    expect(config.isTest).toBe(true);
  });

  it('rejects invalid HOUSEHOLD_TIMEZONE, AUTH_MODE, and AUTO_ARCHIVE_DAYS', () => {
    expect(() => readConfig({ HOUSEHOLD_TIMEZONE: 'Not/A_Real_Zone' })).toThrow(
      /Invalid HOUSEHOLD_TIMEZONE/,
    );
    expect(() => readConfig({ AUTH_MODE: 'magic' })).toThrow(/Invalid AUTH_MODE/);
    expect(() => readConfig({ AUTO_ARCHIVE_DAYS: '0' })).toThrow(/Invalid AUTO_ARCHIVE_DAYS/);
    expect(() => readConfig({ AUTO_ARCHIVE_DAYS: 'abc' })).toThrow(/Invalid AUTO_ARCHIVE_DAYS/);
  });
});

describe('Express middleware, Zod validation helper & structured error handler', () => {
  it('preserves valid X-Request-Id and generates UUID when missing or unsafe', () => {
    const mock1 = createMockResponse();
    const req1 = {
      header: () => 'req_abc-123.test',
    } as unknown as Request;
    const next1 = vi.fn() as unknown as NextFunction;
    requestIdMiddleware(req1, mock1.res, next1);
    expect(req1.requestId).toBe('req_abc-123.test');
    expect(mock1.getHeader('x-request-id')).toBe('req_abc-123.test');
    expect(next1).toHaveBeenCalledOnce();

    const mock2 = createMockResponse();
    const req2 = {
      header: () => 'bad header with spaces!',
    } as unknown as Request;
    const next2 = vi.fn() as unknown as NextFunction;
    requestIdMiddleware(req2, mock2.res, next2);
    expect(req2.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(mock2.getHeader('x-request-id')).toBe(req2.requestId);
  });

  it('validates payloads via parseWithSchema and validateRequest', () => {
    const schema = z.object({ title: z.string().trim().min(1) });
    expect(parseWithSchema(schema, { title: '  Fix sink  ' })).toEqual({ title: 'Fix sink' });
    expect(() => parseWithSchema(schema, { title: '' })).toThrow(AppError);

    const middleware = validateRequest({ body: schema });

    const okReq = { body: { title: '  Renew books  ' } } as unknown as Request;
    const okNext = vi.fn();
    middleware(okReq, createMockResponse().res, okNext as unknown as NextFunction);
    expect(okReq.body).toEqual({ title: 'Renew books' });
    expect(okNext).toHaveBeenCalledWith();

    const badReq = { body: { title: '' } } as unknown as Request;
    const badNext = vi.fn();
    middleware(badReq, createMockResponse().res, badNext as unknown as NextFunction);
    const err = badNext.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).code).toBe('VALIDATION_ERROR');
  });

  it('formats AppError, ZodError, body-parser errors, and unexpected errors consistently', () => {
    const req = { requestId: 'test-req-1' } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;

    const m1 = createMockResponse();
    errorHandler(new AppError(404, 'NOT_FOUND', 'Card not found', { id: 'c1' }), req, m1.res, next);
    expect(m1.getStatus()).toBe(404);
    expect(m1.getJson()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Card not found',
        details: { id: 'c1' },
      },
    });

    const m2 = createMockResponse();
    const zodResult = z.object({ count: z.number() }).safeParse({ count: 'nope' });
    expect(zodResult.success).toBe(false);
    errorHandler((zodResult as { success: false; error: ZodError }).error, req, m2.res, next);
    expect(m2.getStatus()).toBe(400);
    expect((m2.getJson() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const m3 = createMockResponse();
    const tooLarge = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
    });
    errorHandler(tooLarge, req, m3.res, next);
    expect(m3.getStatus()).toBe(413);
    expect((m3.getJson() as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');

    const m4 = createMockResponse();
    const parseFailed = Object.assign(new Error('Unexpected token'), {
      type: 'entity.parse.failed',
    });
    errorHandler(parseFailed, req, m4.res, next);
    expect(m4.getStatus()).toBe(400);
    expect((m4.getJson() as { error: { code: string } }).error.code).toBe('INVALID_JSON');

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m5 = createMockResponse();
    errorHandler(new Error('Sensitive internal failure'), req, m5.res, next);
    expect(m5.getStatus()).toBe(500);
    expect(m5.getJson()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
    consoleErrorSpy.mockRestore();
  });
});
