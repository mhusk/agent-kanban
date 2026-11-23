import { describe, expect, it } from 'vitest';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const REGION = 'us-central1';
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const BASE_URL = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/api`;

describe('Cloud Functions Emulator API smoke test', () => {
  it('GET /api/health returns HTTP 200 with { ok: true, timestamp, version }', async () => {
    const res = await fetch(`${BASE_URL}/api/health`, {
      headers: {
        'x-request-id': 'smoke-health-check',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/i);
    expect(res.headers.get('x-request-id')).toBe('smoke-health-check');

    const body = (await res.json()) as {
      ok: boolean;
      service: string;
      timestamp: string;
      version: string;
    };

    expect(body.ok).toBe(true);
    expect(body.service).toBe('agent-kanban');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('returns structured JSON 404 for unknown routes', async () => {
    const res = await fetch(`${BASE_URL}/api/does-not-exist`);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/i);
    expect(res.headers.get('x-request-id')).toBeTruthy();

    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
      };
    };

    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('/api/does-not-exist');
  });

  it('handles JSON POST requests to unknown routes with structured JSON 404', async () => {
    const res = await fetch(`${BASE_URL}/api/does-not-exist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ping: true }),
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/i);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
      };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('POST /api/does-not-exist');
  });
});
