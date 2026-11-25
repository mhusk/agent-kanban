import { pathToFileURL } from 'node:url';

export interface ProdSmokeOptions {
  prodUrl: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export interface ProdSmokeResult {
  healthOk: boolean;
  oauthResource: string;
  snapshotChecked: boolean;
  snapshotCardCount?: number;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Invalid PROD_URL protocol: ${parsed.protocol}`);
  }
  return trimmed;
}

/**
 * Non-destructive smoke check against a deployed agent-kanban instance:
 * 1. GET /api/health -> 200 & ok === true
 * 2. GET /.well-known/oauth-protected-resource -> 200 & resource ends with /mcp
 * 3. Optional SMOKE_API_KEY: GET /api/workspace/snapshot -> 200 & cards array
 */
export async function runProdSmoke(options: ProdSmokeOptions): Promise<ProdSmokeResult> {
  const baseUrl = normalizeBaseUrl(options.prodUrl);
  const fetchImpl = options.fetchFn ?? fetch;

  const healthRes = await fetchImpl(`${baseUrl}/api/health`);
  if (!healthRes.ok) {
    throw new Error(`/api/health failed with HTTP ${healthRes.status}`);
  }
  const healthJson = (await healthRes.json()) as { ok?: unknown };
  if (healthJson.ok !== true) {
    throw new Error(`/api/health returned unexpected payload: ${JSON.stringify(healthJson)}`);
  }

  const oauthRes = await fetchImpl(`${baseUrl}/.well-known/oauth-protected-resource`);
  if (!oauthRes.ok) {
    throw new Error(`/.well-known/oauth-protected-resource failed with HTTP ${oauthRes.status}`);
  }
  const oauthJson = (await oauthRes.json()) as { resource?: unknown };
  if (typeof oauthJson.resource !== 'string' || !oauthJson.resource.endsWith('/mcp')) {
    throw new Error(
      `/.well-known/oauth-protected-resource returned invalid resource: ${String(oauthJson.resource)}`,
    );
  }

  const trimmedKey = options.apiKey?.trim();
  if (!trimmedKey) {
    return {
      healthOk: true,
      oauthResource: oauthJson.resource,
      snapshotChecked: false,
    };
  }

  const snapshotRes = await fetchImpl(`${baseUrl}/api/workspace/snapshot`, {
    headers: {
      Authorization: `Bearer ${trimmedKey}`,
      'X-Agent-Name': 'Production Smoke Check',
    },
  });
  if (!snapshotRes.ok) {
    throw new Error(`/api/workspace/snapshot failed with HTTP ${snapshotRes.status}`);
  }
  const snapshotJson = (await snapshotRes.json()) as { cards?: unknown };
  if (!Array.isArray(snapshotJson.cards)) {
    throw new Error('/api/workspace/snapshot response did not contain a cards array');
  }

  return {
    healthOk: true,
    oauthResource: oauthJson.resource,
    snapshotChecked: true,
    snapshotCardCount: snapshotJson.cards.length,
  };
}

async function main(): Promise<void> {
  const prodUrl = process.env.PROD_URL;
  if (!prodUrl || !prodUrl.trim()) {
    console.error(
      'Usage: PROD_URL=https://<your-domain> [SMOKE_API_KEY=...] pnpm exec tsx scripts/smoke-prod.ts',
    );
    process.exitCode = 1;
    return;
  }

  const result = await runProdSmoke({
    prodUrl,
    apiKey: process.env.SMOKE_API_KEY,
  });

  console.log(`Health OK: ${result.healthOk}`);
  console.log(`OAuth Protected Resource: ${result.oauthResource}`);
  if (result.snapshotChecked) {
    console.log(`Workspace Snapshot OK (${result.snapshotCardCount ?? 0} visible cards)`);
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((err) => {
    console.error('Production smoke check failed:', err);
    process.exitCode = 1;
  });
}
