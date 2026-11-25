import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, resolveEncryptionKey } from '../lib/crypto.js';

describe('AES-256-GCM webhook secret encryption (crypto.ts)', () => {
  const base64Key = crypto.randomBytes(32).toString('base64');
  const hexKey = crypto.randomBytes(32).toString('hex');

  it('round-trips secrets with base64 and hex 32-byte keys and fresh random IVs', () => {
    const configB64 = { webhookEncryptionKey: base64Key, isEmulator: false, isTest: false };
    const secret = 'whsec-super-sensitive-webhook-token-value';

    const cipher1 = encryptSecret(secret, configB64);
    const cipher2 = encryptSecret(secret, configB64);

    expect(cipher1).toMatch(/^v1:/);
    expect(cipher2).toMatch(/^v1:/);
    expect(cipher1).not.toBe(cipher2);
    expect(cipher1).not.toContain(secret);
    expect(decryptSecret(cipher1, configB64)).toBe(secret);
    expect(decryptSecret(cipher2, configB64)).toBe(secret);

    const configHex = { webhookEncryptionKey: hexKey, isEmulator: false, isTest: false };
    const cipherHex = encryptSecret(secret, configHex);
    expect(decryptSecret(cipherHex, configHex)).toBe(secret);
  });

  it('rejects tampered ciphertext, wrong keys, invalid key sizes, and missing prod key', () => {
    const config1 = { webhookEncryptionKey: base64Key, isEmulator: false, isTest: false };
    const config2 = { webhookEncryptionKey: hexKey, isEmulator: false, isTest: false };

    const encrypted = encryptSecret('secret-one-two-three-four', config1);
    const parts = encrypted.split(':');
    const ctBuf = Buffer.from(parts[3]!, 'base64');
    ctBuf[0] = (ctBuf[0]! ^ 0xff) & 0xff;
    const tampered = [parts[0], parts[1], parts[2], ctBuf.toString('base64')].join(':');

    expect(() => decryptSecret(tampered, config1)).toThrow(/decrypt/i);
    expect(() => decryptSecret(encrypted, config2)).toThrow(/decrypt/i);
    expect(() => decryptSecret('v2:abc:def:ghi', config1)).toThrow(/Unsupported/);

    expect(() =>
      resolveEncryptionKey({
        webhookEncryptionKey: Buffer.from('too-short').toString('base64'),
        isEmulator: true,
        isTest: true,
      }),
    ).toThrow(/32 bytes/);

    expect(() =>
      resolveEncryptionKey({
        webhookEncryptionKey: null,
        isEmulator: false,
        isTest: false,
      }),
    ).toThrow(/WEBHOOK_ENCRYPTION_KEY/);
  });

  it('provides a consistent emulator/test fallback key when unset in emulator or test mode', () => {
    const keyEmu = resolveEncryptionKey({
      webhookEncryptionKey: null,
      isEmulator: true,
      isTest: false,
    });
    const keyTest = resolveEncryptionKey({
      webhookEncryptionKey: null,
      isEmulator: false,
      isTest: true,
    });
    expect(keyEmu.length).toBe(32);
    expect(keyEmu.equals(keyTest)).toBe(true);
  });
});
