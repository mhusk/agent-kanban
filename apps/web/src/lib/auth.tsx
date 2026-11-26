import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthKitProvider, useAuth as useWorkOSAuth } from '@workos-inc/authkit-react';
import { useNavigate } from 'react-router-dom';
import { isApiError, requestDevToken, type DevTokenRequest } from './api.js';

export type WebAuthMode = 'emulator' | 'workos';

const PLACEHOLDER_WORKOS_CLIENT_ID = 'client_example_placeholder';
const EMULATOR_SESSION_KEY = 'agent-kanban:emulator-session';

export interface EmulatorDevPreset {
  handle: string;
  displayName: string;
  email: string;
  roleLabel: string;
}

export const EMULATOR_DEV_USERS: readonly EmulatorDevPreset[] = [
  {
    handle: 'alex',
    displayName: 'Alex Rivera',
    email: 'alex@example.test',
    roleLabel: 'Admin',
  },
  {
    handle: 'sam',
    displayName: 'Sam Rivera',
    email: 'sam@example.test',
    roleLabel: 'Member',
  },
] as const;

export interface AppAuthContextValue {
  mode: WebAuthMode;
  isLoading: boolean;
  isAuthenticated: boolean;
  providerEmail: string | null;
  authError: string | null;
  getAccessToken: () => Promise<string | null>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  signInAsEmulatorUser: (request: DevTokenRequest) => Promise<void>;
  clearAuthError: () => void;
}

interface StoredEmulatorSession {
  token: string;
  email: string;
}

const AppAuthContext = createContext<AppAuthContextValue | null>(null);

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function getConfiguredWorkOSClientId(): string | null {
  const raw = import.meta.env.VITE_WORKOS_CLIENT_ID?.trim();
  if (!raw || raw === PLACEHOLDER_WORKOS_CLIENT_ID) {
    return null;
  }
  return raw;
}

/**
 * Optional WorkOS custom auth domain (e.g. `auth.example.com`). When set, AuthKit
 * uses a first-party HttpOnly session cookie so sessions survive page reloads in
 * production without storing refresh tokens in localStorage.
 */
export function resolveWorkOSApiHostname(
  raw: string | undefined = import.meta.env.VITE_WORKOS_API_HOSTNAME,
): string | undefined {
  const trimmed = raw
    ?.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

/**
 * Opt-in session persistence for deployments without a WorkOS custom auth domain.
 * `VITE_WORKOS_PERSIST_SESSION=localstorage` stores the refresh token in localStorage
 * (AuthKit `devMode`) so sessions survive reloads. It is readable by any XSS bug, so it
 * is off by default; prefer `VITE_WORKOS_API_HOSTNAME` where a custom domain is available.
 * Returns `undefined` to keep AuthKit's default (localStorage only on localhost).
 */
export function resolveWorkOSDevMode(
  raw: string | undefined = import.meta.env.VITE_WORKOS_PERSIST_SESSION,
  apiHostname: string | undefined = resolveWorkOSApiHostname(),
): boolean | undefined {
  if (apiHostname) {
    return false;
  }
  return raw?.trim().toLowerCase() === 'localstorage' ? true : undefined;
}

export function resolveWebAuthMode(
  explicitRaw: string | undefined = import.meta.env.VITE_AUTH_MODE,
  workosClientId: string | null = getConfiguredWorkOSClientId(),
  hostname: string = typeof window !== 'undefined' ? window.location.hostname : '',
): WebAuthMode {
  const explicit = explicitRaw?.trim().toLowerCase();
  const local = isLocalHostname(hostname);

  if (explicit === 'workos') {
    return 'workos';
  }
  if (explicit === 'emulator') {
    // Fail closed to WorkOS outside localhost/127.0.0.1 even if misconfigured.
    return local ? 'emulator' : 'workos';
  }
  // When running locally against Firebase Emulators without WorkOS client config,
  // default to emulator auth mode so local/CI runs need no untracked .env files.
  return local && workosClientId === null ? 'emulator' : 'workos';
}

function readStoredEmulatorSession(): StoredEmulatorSession | null {
  try {
    const raw = window.sessionStorage.getItem(EMULATOR_SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredEmulatorSession>;
    if (typeof parsed.token === 'string' && parsed.token.length > 0) {
      return {
        token: parsed.token,
        email: typeof parsed.email === 'string' ? parsed.email : '',
      };
    }
  } catch {
    // Ignore storage read errors (e.g., private browsing restrictions)
  }
  return null;
}

function writeStoredEmulatorSession(session: StoredEmulatorSession | null): void {
  try {
    if (session === null) {
      window.sessionStorage.removeItem(EMULATOR_SESSION_KEY);
    } else {
      window.sessionStorage.setItem(EMULATOR_SESSION_KEY, JSON.stringify(session));
    }
  } catch {
    // Ignore storage write errors
  }
}

function EmulatorAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<StoredEmulatorSession | null>(() =>
    readStoredEmulatorSession(),
  );
  const [isBusy, setIsBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    return session?.token ?? null;
  }, [session]);

  const signInAsEmulatorUser = useCallback(
    async (request: DevTokenRequest): Promise<void> => {
      setIsBusy(true);
      setAuthError(null);
      try {
        const result = await requestDevToken(request);
        const nextSession: StoredEmulatorSession = {
          token: result.token,
          email: result.user?.email ?? result.claims.email,
        };
        queryClient.clear();
        writeStoredEmulatorSession(nextSession);
        setSession(nextSession);
      } catch (error) {
        const message = isApiError(error)
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Unable to sign in with emulator account';
        setAuthError(message);
      } finally {
        setIsBusy(false);
      }
    },
    [queryClient],
  );

  const signIn = useCallback(async (): Promise<void> => {
    const defaultPreset = EMULATOR_DEV_USERS[0];
    if (defaultPreset) {
      await signInAsEmulatorUser({ handle: defaultPreset.handle });
    }
  }, [signInAsEmulatorUser]);

  const signOut = useCallback(async (): Promise<void> => {
    writeStoredEmulatorSession(null);
    setSession(null);
    setAuthError(null);
    queryClient.clear();
  }, [queryClient]);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const value = useMemo<AppAuthContextValue>(
    () => ({
      mode: 'emulator',
      isLoading: isBusy,
      isAuthenticated: session !== null,
      providerEmail: session?.email ?? null,
      authError,
      getAccessToken,
      signIn,
      signOut,
      signInAsEmulatorUser,
      clearAuthError,
    }),
    [
      session,
      isBusy,
      authError,
      getAccessToken,
      signIn,
      signOut,
      signInAsEmulatorUser,
      clearAuthError,
    ],
  );

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

function WorkOSAuthBridge({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const workos = useWorkOSAuth();
  const [authError, setAuthError] = useState<string | null>(null);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    try {
      const token = await workos.getAccessToken();
      return token || null;
    } catch {
      return null;
    }
  }, [workos]);

  const signIn = useCallback(async (): Promise<void> => {
    setAuthError(null);
    try {
      await workos.signIn();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to start WorkOS sign-in');
    }
  }, [workos]);

  const signOut = useCallback(async (): Promise<void> => {
    queryClient.clear();
    await workos.signOut({ returnTo: window.location.origin });
  }, [queryClient, workos]);

  const signInAsEmulatorUser = useCallback(async (): Promise<void> => {
    setAuthError('Dev user switcher is only available in local emulator mode.');
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const value = useMemo<AppAuthContextValue>(
    () => ({
      mode: 'workos',
      isLoading: workos.isLoading,
      isAuthenticated: workos.user !== null,
      providerEmail: workos.user?.email ?? null,
      authError,
      getAccessToken,
      signIn,
      signOut,
      signInAsEmulatorUser,
      clearAuthError,
    }),
    [
      workos.isLoading,
      workos.user,
      authError,
      getAccessToken,
      signIn,
      signOut,
      signInAsEmulatorUser,
      clearAuthError,
    ],
  );

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

function UnconfiguredWorkOSProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AppAuthContextValue>(
    () => ({
      mode: 'workos',
      isLoading: false,
      isAuthenticated: false,
      providerEmail: null,
      authError:
        'WorkOS AuthKit is not configured yet. Set VITE_WORKOS_CLIENT_ID in your build environment.',
      getAccessToken: async () => null,
      signIn: async () => undefined,
      signOut: async () => undefined,
      signInAsEmulatorUser: async () => undefined,
      clearAuthError: () => undefined,
    }),
    [],
  );

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

export function AppAuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const handleRedirectCallback = useCallback(() => {
    navigate('/', { replace: true });
  }, [navigate]);

  const mode = resolveWebAuthMode();

  if (mode === 'emulator') {
    return <EmulatorAuthProvider>{children}</EmulatorAuthProvider>;
  }

  const clientId = getConfiguredWorkOSClientId();
  if (!clientId) {
    return <UnconfiguredWorkOSProvider>{children}</UnconfiguredWorkOSProvider>;
  }

  const redirectUri = `${window.location.origin}/callback`;

  return (
    <AuthKitProvider
      clientId={clientId}
      redirectUri={redirectUri}
      apiHostname={resolveWorkOSApiHostname()}
      devMode={resolveWorkOSDevMode()}
      onRedirectCallback={handleRedirectCallback}
    >
      <WorkOSAuthBridge>{children}</WorkOSAuthBridge>
    </AuthKitProvider>
  );
}

export function useAppAuth(): AppAuthContextValue {
  const ctx = useContext(AppAuthContext);
  if (!ctx) {
    throw new Error('useAppAuth must be used inside AppAuthProvider');
  }
  return ctx;
}
