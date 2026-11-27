import { describe, expect, it } from 'vitest';
import {
  constantTimeEqualHex,
  formatAgentAttribution,
  generateApiKey,
  hashApiKey,
  isApiKeyToken,
} from '../lib/apiKeys.js';

describe('apiKeys helpers', () => {
  it('generates prefixed keys with SHA-256 hashes and verifies constant-time equality', () => {
    const generated = generateApiKey();
    expect(generated.keyPrefix).toMatch(/^ak_[A-Za-z0-9]{8}$/);
    expect(generated.fullKey.startsWith(`${generated.keyPrefix}_`)).toBe(true);
    expect(generated.fullKey.length).toBeGreaterThanOrEqual(50);
    expect(generated.hashedKey).toBe(hashApiKey(generated.fullKey));
    expect(generated.hashedKey).toMatch(/^[a-f0-9]{64}$/);

    expect(isApiKeyToken(generated.fullKey)).toBe(true);
    expect(isApiKeyToken('eyJhbGciOiJSUzI1NiJ9.payload.sig')).toBe(false);

    expect(constantTimeEqualHex(generated.hashedKey, hashApiKey(generated.fullKey))).toBe(true);
    expect(constantTimeEqualHex(generated.hashedKey, hashApiKey(`${generated.fullKey}x`))).toBe(
      false,
    );
    expect(constantTimeEqualHex('abcd', 'abcdef')).toBe(false);
  });

  it('formats canonical agent attribution strings and deduplicates identical names', () => {
    expect(formatAgentAttribution('Chief of Staff', 'Automation Bot')).toBe(
      'Chief of Staff via Automation Bot (agent)',
    );
    expect(formatAgentAttribution('Automation Bot', 'Automation Bot')).toBe(
      'Automation Bot (agent)',
    );
    expect(formatAgentAttribution('automation bot', 'Automation Bot')).toBe(
      'Automation Bot (agent)',
    );
    expect(formatAgentAttribution(null, 'Automation Bot')).toBe('Automation Bot (agent)');
    expect(formatAgentAttribution(null, null)).toBe('Agent (agent)');
  });
});
