import { describe, expect, it } from 'vitest';
import { resolveWorkOSApiHostname, resolveWorkOSDevMode } from '../lib/auth.js';

describe('resolveWorkOSApiHostname', () => {
  it('returns undefined when unset or blank', () => {
    expect(resolveWorkOSApiHostname('')).toBeUndefined();
    expect(resolveWorkOSApiHostname('   ')).toBeUndefined();
  });

  it('returns a bare hostname unchanged', () => {
    expect(resolveWorkOSApiHostname('auth.example.test')).toBe('auth.example.test');
  });

  it('strips scheme and trailing slashes', () => {
    expect(resolveWorkOSApiHostname(' https://auth.example.test/ ')).toBe('auth.example.test');
  });
});

describe('resolveWorkOSDevMode', () => {
  it('defaults to AuthKit behavior when unset', () => {
    expect(resolveWorkOSDevMode('', undefined)).toBeUndefined();
    expect(resolveWorkOSDevMode('other', undefined)).toBeUndefined();
  });

  it('enables localStorage persistence when opted in', () => {
    expect(resolveWorkOSDevMode(' LocalStorage ', undefined)).toBe(true);
  });

  it('prefers the secure cookie flow when a custom hostname is set', () => {
    expect(resolveWorkOSDevMode('localstorage', 'auth.example.test')).toBe(false);
  });
});
