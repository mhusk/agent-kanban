export type AuthMode = 'workos' | 'emulator';

export interface AppConfig {
  authMode: AuthMode;
  householdTimezone: string;
  autoArchiveDays: number;
  workosClientId: string | null;
  workosJwksUrl: string | null;
  workosIssuer: string | null;
  webhookEncryptionKey: string | null;
  backupBucket: string | null;
  isEmulator: boolean;
  isTest: boolean;
}

const DEFAULT_HOUSEHOLD_TIMEZONE = 'UTC';
const DEFAULT_AUTO_ARCHIVE_DAYS = 30;

function optionalEnv(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isValidIanaTimezone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseAuthMode(raw: string | undefined): AuthMode {
  const normalized = optionalEnv(raw)?.toLowerCase() ?? 'workos';
  if (normalized === 'workos' || normalized === 'emulator') {
    return normalized;
  }
  throw new Error(`Invalid AUTH_MODE "${normalized}". Expected "workos" or "emulator".`);
}

function parseAutoArchiveDays(raw: string | undefined): number {
  const trimmed = optionalEnv(raw);
  if (trimmed === null) {
    return DEFAULT_AUTO_ARCHIVE_DAYS;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid AUTO_ARCHIVE_DAYS "${trimmed}". Expected a positive integer.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid AUTO_ARCHIVE_DAYS "${trimmed}". Expected an integer >= 1.`);
  }
  return parsed;
}

function parseHouseholdTimezone(raw: string | undefined): string {
  const tz = optionalEnv(raw) ?? DEFAULT_HOUSEHOLD_TIMEZONE;
  if (!isValidIanaTimezone(tz)) {
    throw new Error(`Invalid HOUSEHOLD_TIMEZONE "${tz}". Expected a valid IANA timezone.`);
  }
  return tz;
}

/**
 * Enforces the hard security invariant that `AUTH_MODE=emulator` is strictly
 * prohibited outside Firebase Emulators (`FUNCTIONS_EMULATOR=true`) or test
 * environments (`NODE_ENV=test`).
 */
export function assertEmulatorAuthAllowed(
  config: Pick<AppConfig, 'authMode' | 'isEmulator' | 'isTest'>,
): void {
  if (config.authMode === 'emulator' && !config.isEmulator && !config.isTest) {
    throw new Error(
      'FATAL: AUTH_MODE=emulator is strictly prohibited outside Firebase Emulators (FUNCTIONS_EMULATOR=true) or test mode (NODE_ENV=test).',
    );
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isEmulator = env.FUNCTIONS_EMULATOR === 'true';
  const isTest = env.NODE_ENV === 'test';

  const config: AppConfig = {
    authMode: parseAuthMode(env.AUTH_MODE),
    householdTimezone: parseHouseholdTimezone(env.HOUSEHOLD_TIMEZONE),
    autoArchiveDays: parseAutoArchiveDays(env.AUTO_ARCHIVE_DAYS),
    workosClientId: optionalEnv(env.WORKOS_CLIENT_ID),
    workosJwksUrl: optionalEnv(env.WORKOS_JWKS_URL),
    workosIssuer: optionalEnv(env.WORKOS_ISSUER),
    webhookEncryptionKey: optionalEnv(env.WEBHOOK_ENCRYPTION_KEY),
    backupBucket: optionalEnv(env.BACKUP_BUCKET),
    isEmulator,
    isTest,
  };

  assertEmulatorAuthAllowed(config);
  return config;
}

export function getConfig(): AppConfig {
  return readConfig(process.env);
}
