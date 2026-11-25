import { CardSchema, UserSchema, type Card, type User } from '@agent-kanban/shared';

export interface StructuredErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export type AccessTokenProvider = () => Promise<string | null>;

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  getAccessToken?: AccessTokenProvider;
  signal?: AbortSignal;
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toApiError(status: number, payload: unknown, statusText: string): ApiError {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const err = (payload as StructuredErrorPayload).error;
    if (err && typeof err === 'object') {
      const code =
        typeof err.code === 'string' && err.code.length > 0 ? err.code : `HTTP_${status}`;
      const message =
        typeof err.message === 'string' && err.message.length > 0
          ? err.message
          : statusText || `Request failed with status ${status}`;
      return new ApiError(status, code, message, err.details);
    }
  }

  return new ApiError(
    status,
    `HTTP_${status}`,
    statusText || `Request failed with status ${status}`,
  );
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');

  if (options.getAccessToken) {
    const token = await options.getAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  let bodyInit: string | undefined;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    bodyInit = JSON.stringify(options.body);
  }

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: bodyInit,
    signal: options.signal,
  });

  const payload = await parseJsonSafe(response);

  if (!response.ok) {
    throw toApiError(response.status, payload, response.statusText);
  }

  return payload as T;
}

export async function fetchCurrentUser(
  getAccessToken: AccessTokenProvider,
  signal?: AbortSignal,
): Promise<User> {
  const data = await apiRequest<{ user: unknown }>('/api/me', {
    getAccessToken,
    signal,
  });
  return UserSchema.parse(data.user);
}

export async function fetchHouseholdUsers(
  getAccessToken: AccessTokenProvider,
  signal?: AbortSignal,
): Promise<User[]> {
  const data = await apiRequest<{ users: unknown }>('/api/users', {
    getAccessToken,
    signal,
  });
  return UserSchema.array().parse(data.users);
}

export interface CardListFilters {
  status?: string;
  tag?: string;
  assignedTo?: string;
  awareOf?: string;
  archived?: 'true' | 'false' | 'all';
  sort?: 'priority' | 'updated';
}

export async function fetchCards(
  getAccessToken: AccessTokenProvider,
  filters: CardListFilters = {},
  signal?: AbortSignal,
): Promise<Card[]> {
  const params = new URLSearchParams();
  if (filters.status !== undefined) {
    params.set('status', filters.status);
  }
  if (filters.tag !== undefined) {
    params.set('tag', filters.tag);
  }
  if (filters.assignedTo !== undefined) {
    params.set('assignedTo', filters.assignedTo);
  }
  if (filters.awareOf !== undefined) {
    params.set('awareOf', filters.awareOf);
  }
  if (filters.archived !== undefined) {
    params.set('archived', filters.archived);
  }
  if (filters.sort !== undefined) {
    params.set('sort', filters.sort);
  }
  const qs = params.toString();
  const path = qs.length > 0 ? `/api/cards?${qs}` : '/api/cards';
  const data = await apiRequest<{ cards: unknown }>(path, {
    getAccessToken,
    signal,
  });
  return CardSchema.array().parse(data.cards);
}

export async function searchCards(
  getAccessToken: AccessTokenProvider,
  q: string,
  archived: 'true' | 'false' | 'all' = 'false',
  signal?: AbortSignal,
): Promise<Card[]> {
  const params = new URLSearchParams({ q, archived });
  const data = await apiRequest<{ cards: unknown }>(`/api/cards/search?${params.toString()}`, {
    getAccessToken,
    signal,
  });
  return CardSchema.array().parse(data.cards);
}

export interface DevTokenRequest {
  handle?: string;
  email?: string;
  userId?: string;
  allowUnregistered?: boolean;
}

export interface DevTokenResponse {
  token: string;
  expiresIn: number;
  user?: User;
  claims: {
    sub: string;
    email: string;
    email_verified: boolean;
  };
}

export async function requestDevToken(payload: DevTokenRequest): Promise<DevTokenResponse> {
  const data = await apiRequest<DevTokenResponse>('/api/dev/token', {
    method: 'POST',
    body: payload,
  });
  if (typeof data?.token !== 'string' || data.token.length === 0) {
    throw new ApiError(500, 'INVALID_TOKEN_RESPONSE', 'Dev token endpoint did not return a token');
  }
  return data;
}
