import crypto from 'node:crypto';

export const API_KEY_PREFIX = 'ak_';
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PREFIX_RANDOM_LENGTH = 8;
const SECRET_BYTES = 32;

export interface GeneratedApiKey {
  fullKey: string;
  keyPrefix: string;
  hashedKey: string;
}

export function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

export function hashApiKey(fullKey: string): string {
  return crypto.createHash('sha256').update(fullKey, 'utf8').digest('hex');
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateApiKey(): GeneratedApiKey {
  let prefixChars = '';
  for (let i = 0; i < PREFIX_RANDOM_LENGTH; i += 1) {
    prefixChars += ALPHANUM[crypto.randomInt(0, ALPHANUM.length)]!;
  }

  const secretPart = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const keyPrefix = `${API_KEY_PREFIX}${prefixChars}`;
  const fullKey = `${keyPrefix}_${secretPart}`;
  const hashedKey = hashApiKey(fullKey);

  return {
    fullKey,
    keyPrefix,
    hashedKey,
  };
}

export function formatAgentAttribution(
  agentName: string | null | undefined,
  platform: string | null | undefined,
): string {
  const trimmedAgent = agentName?.trim() || null;
  const trimmedPlatform = platform?.trim() || null;

  if (trimmedAgent && trimmedPlatform) {
    if (trimmedAgent.toLowerCase() === trimmedPlatform.toLowerCase()) {
      return `${trimmedPlatform} (agent)`;
    }
    return `${trimmedAgent} via ${trimmedPlatform} (agent)`;
  }
  return `${trimmedAgent ?? trimmedPlatform ?? 'Agent'} (agent)`;
}
