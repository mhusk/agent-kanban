import { describe, expect, it } from 'vitest';
import { runProdSmoke } from '../smoke-prod.js';

describe('runProdSmoke', () => {
  it('verifies /api/health and /.well-known/oauth-protected-resource without an API key', async () => {
    const calls: Array<{ url: string; headers?: unknown }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, headers: init?.headers });

      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify({ resource: 'https://example.test/mcp' }), {
          status: 200,
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const res = await runProdSmoke({
      prodUrl: 'https://example.test/',
      fetchFn: mockFetch,
    });

    expect(res).toEqual({
      healthOk: true,
      oauthResource: 'https://example.test/mcp',
      snapshotChecked: false,
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://example.test/api/health',
      'https://example.test/.well-known/oauth-protected-resource',
    ]);
  });

  it('also verifies /api/workspace/snapshot when SMOKE_API_KEY is supplied and fails on non-200', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify({ resource: 'https://example.test/mcp' }), {
          status: 200,
        });
      }
      if (url.endsWith('/api/workspace/snapshot')) {
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.Authorization).toBe('Bearer test-smoke-token');
        expect(headers?.['X-Agent-Name']).toBe('Production Smoke Check');
        return new Response(JSON.stringify({ cards: [{ id: 'c1' }, { id: 'c2' }] }), {
          status: 200,
        });
      }
      return new Response('Unexpected', { status: 500 });
    };

    const okRes = await runProdSmoke({
      prodUrl: 'https://example.test',
      apiKey: 'test-smoke-token',
      fetchFn: mockFetch,
    });
    expect(okRes).toEqual({
      healthOk: true,
      oauthResource: 'https://example.test/mcp',
      snapshotChecked: true,
      snapshotCardCount: 2,
    });

    const failingFetch: typeof fetch = async () => new Response('Unavailable', { status: 503 });
    await expect(
      runProdSmoke({ prodUrl: 'https://example.test', fetchFn: failingFetch }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
