import {
  ActivitySchema,
  AgentConnectionSchema,
  AttachmentSchema,
  CardSchema,
  ChecklistItemSchema,
  ChecklistSchema,
  CommentSchema,
  LinkAttachmentSchema,
  SubscriptionEmulatorSchema,
  SubscriptionSchema,
  UserSchema,
  type Activity,
  type AgentConnection,
  type AllowedAttachmentMimeType,
  type Attachment,
  type Card,
  type CardStatus,
  type Checklist,
  type ChecklistItem,
  type Comment,
  type CreateCardInput,
  type CreateChecklistInput,
  type CreateLinkAttachmentInput,
  type LinkAttachment,
  type Subscription,
  type UpdateCardInput,
  type UpdateChecklistInput,
  type User,
  type WebhookAuthType,
} from '@agent-kanban/shared';

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

export async function fetchCard(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  signal?: AbortSignal,
): Promise<Card> {
  const data = await apiRequest<{ card: unknown }>(`/api/cards/${encodeURIComponent(cardId)}`, {
    getAccessToken,
    signal,
  });
  return CardSchema.parse(data.card);
}

export async function createCard(
  getAccessToken: AccessTokenProvider,
  payload: Partial<CreateCardInput> & { title: string },
  idempotencyKey?: string,
): Promise<Card> {
  const data = await apiRequest<{ card: unknown }>('/api/cards', {
    method: 'POST',
    body: payload,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    getAccessToken,
  });
  return CardSchema.parse(data.card);
}

export async function updateCard(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  payload: UpdateCardInput,
): Promise<Card> {
  const data = await apiRequest<{ card: unknown }>(`/api/cards/${encodeURIComponent(cardId)}`, {
    method: 'PATCH',
    body: payload,
    getAccessToken,
  });
  return CardSchema.parse(data.card);
}

export async function changeCardStatus(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  status: CardStatus,
  opts?: { ifUpdatedAt?: string; note?: string },
): Promise<Card> {
  const data = await apiRequest<{ card: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/status`,
    {
      method: 'POST',
      body: { status, ...opts },
      getAccessToken,
    },
  );
  return CardSchema.parse(data.card);
}

export async function completeCard(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  opts?: { ifUpdatedAt?: string; note?: string },
): Promise<{ card: Card; recurringReset: boolean }> {
  const data = await apiRequest<{ card: unknown; recurringReset: boolean }>(
    `/api/cards/${encodeURIComponent(cardId)}/complete`,
    {
      method: 'POST',
      body: opts ?? {},
      getAccessToken,
    },
  );
  return {
    card: CardSchema.parse(data.card),
    recurringReset: Boolean(data.recurringReset),
  };
}

export async function archiveCard(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  archived: boolean,
  opts?: { ifUpdatedAt?: string; note?: string },
): Promise<Card> {
  const data = await apiRequest<{ card: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/archive`,
    {
      method: 'POST',
      body: { archived, ...opts },
      getAccessToken,
    },
  );
  return CardSchema.parse(data.card);
}

export async function createChecklist(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  payload: Partial<CreateChecklistInput> & { title: string },
): Promise<{ card: Card; checklist: Checklist }> {
  const data = await apiRequest<{ card: unknown; checklist: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/checklists`,
    {
      method: 'POST',
      body: payload,
      getAccessToken,
    },
  );
  return {
    card: CardSchema.parse(data.card),
    checklist: ChecklistSchema.parse(data.checklist),
  };
}

export async function updateChecklist(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  checklistId: string,
  payload: UpdateChecklistInput,
): Promise<{ card: Card; checklist: Checklist }> {
  const data = await apiRequest<{ card: unknown; checklist: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/checklists/${encodeURIComponent(checklistId)}`,
    {
      method: 'PATCH',
      body: payload,
      getAccessToken,
    },
  );
  return {
    card: CardSchema.parse(data.card),
    checklist: ChecklistSchema.parse(data.checklist),
  };
}

export async function deleteChecklist(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  checklistId: string,
): Promise<{ card: Card }> {
  const data = await apiRequest<{ card: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/checklists/${encodeURIComponent(checklistId)}`,
    {
      method: 'DELETE',
      body: {},
      getAccessToken,
    },
  );
  return { card: CardSchema.parse(data.card) };
}

export async function addChecklistItem(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  checklistId: string,
  payload: { text: string; checked?: boolean },
): Promise<{ card: Card; item: ChecklistItem }> {
  const data = await apiRequest<{ card: unknown; item: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/checklists/${encodeURIComponent(checklistId)}/items`,
    {
      method: 'POST',
      body: payload,
      getAccessToken,
    },
  );
  return {
    card: CardSchema.parse(data.card),
    item: ChecklistItemSchema.parse(data.item),
  };
}

export async function updateChecklistItem(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  checklistId: string,
  itemId: string,
  payload: { text?: string; checked?: boolean },
): Promise<{ card: Card; item: ChecklistItem }> {
  const data = await apiRequest<{ card: unknown; item: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/checklists/${encodeURIComponent(checklistId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      body: payload,
      getAccessToken,
    },
  );
  return {
    card: CardSchema.parse(data.card),
    item: ChecklistItemSchema.parse(data.item),
  };
}

export async function deleteChecklistItem(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  checklistId: string,
  itemId: string,
): Promise<{ card: Card }> {
  const data = await apiRequest<{ card: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/checklists/${encodeURIComponent(checklistId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: 'DELETE',
      body: {},
      getAccessToken,
    },
  );
  return { card: CardSchema.parse(data.card) };
}

export async function addCardLink(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  payload: CreateLinkAttachmentInput,
): Promise<{ card: Card; link: LinkAttachment }> {
  const data = await apiRequest<{ card: unknown; link: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/links`,
    {
      method: 'POST',
      body: payload,
      getAccessToken,
    },
  );
  return {
    card: CardSchema.parse(data.card),
    link: LinkAttachmentSchema.parse(data.link),
  };
}

export async function deleteCardLink(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  linkId: string,
): Promise<{ card: Card }> {
  const data = await apiRequest<{ card: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/links/${encodeURIComponent(linkId)}`,
    {
      method: 'DELETE',
      body: {},
      getAccessToken,
    },
  );
  return { card: CardSchema.parse(data.card) };
}

export async function fetchCardAttachments(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  signal?: AbortSignal,
): Promise<Attachment[]> {
  const data = await apiRequest<{ attachments: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/attachments`,
    {
      getAccessToken,
      signal,
    },
  );
  return AttachmentSchema.array().parse(data.attachments);
}

export async function requestAttachmentUploadUrl(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  payload: { fileName: string; contentType: AllowedAttachmentMimeType; size: number },
): Promise<{ attachmentId: string; uploadUrl: string; storagePath: string; expiresAt: string }> {
  return apiRequest<{
    attachmentId: string;
    uploadUrl: string;
    storagePath: string;
    expiresAt: string;
  }>(`/api/cards/${encodeURIComponent(cardId)}/attachments/upload-url`, {
    method: 'POST',
    body: payload,
    getAccessToken,
  });
}

export async function uploadFileToSignedUrl(
  uploadUrl: string,
  file: Blob,
  contentType: string,
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body: file,
  });
  if (!res.ok) {
    throw new ApiError(res.status, 'STORAGE_UPLOAD_FAILED', `Upload failed (HTTP ${res.status})`);
  }
}

export async function confirmAttachmentUpload(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  attachmentId: string,
): Promise<Attachment> {
  const data = await apiRequest<{ attachment: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachmentId)}/confirm`,
    {
      method: 'POST',
      body: {},
      getAccessToken,
    },
  );
  return AttachmentSchema.parse(data.attachment);
}

export async function fetchAttachmentDownloadUrl(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<{ downloadUrl: string; expiresAt: string; attachment: Attachment }> {
  const data = await apiRequest<{ downloadUrl: string; expiresAt: string; attachment: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachmentId)}/download-url`,
    {
      getAccessToken,
      signal,
    },
  );
  return {
    downloadUrl: data.downloadUrl,
    expiresAt: data.expiresAt,
    attachment: AttachmentSchema.parse(data.attachment),
  };
}

export async function renameCardAttachment(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  attachmentId: string,
  fileName: string,
): Promise<Attachment> {
  const data = await apiRequest<{ attachment: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachmentId)}`,
    {
      method: 'PATCH',
      body: { fileName },
      getAccessToken,
    },
  );
  return AttachmentSchema.parse(data.attachment);
}

export async function deleteCardAttachment(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  attachmentId: string,
): Promise<{ deleted: true; id: string }> {
  return apiRequest<{ deleted: true; id: string }>(
    `/api/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachmentId)}`,
    {
      method: 'DELETE',
      getAccessToken,
    },
  );
}

export async function fetchCardComments(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  signal?: AbortSignal,
): Promise<Comment[]> {
  const data = await apiRequest<{ comments: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/comments`,
    {
      getAccessToken,
      signal,
    },
  );
  return CommentSchema.array().parse(data.comments);
}

export async function createCardComment(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  text: string,
  note?: string,
): Promise<{ comment: Comment; card: Card }> {
  const data = await apiRequest<{ comment: unknown; card: unknown }>(
    `/api/cards/${encodeURIComponent(cardId)}/comments`,
    {
      method: 'POST',
      body: { text, ...(note ? { note } : {}) },
      getAccessToken,
    },
  );
  return {
    comment: CommentSchema.parse(data.comment),
    card: CardSchema.parse(data.card),
  };
}

export async function fetchCardActivity(
  getAccessToken: AccessTokenProvider,
  cardId: string,
  signal?: AbortSignal,
): Promise<{ activity: Activity[]; nextCursor: string | null }> {
  const data = await apiRequest<{ activity: unknown; nextCursor: string | null }>(
    `/api/cards/${encodeURIComponent(cardId)}/activity`,
    {
      getAccessToken,
      signal,
    },
  );
  return {
    activity: ActivitySchema.array().parse(data.activity),
    nextCursor: data.nextCursor,
  };
}

export async function createHouseholdUser(
  getAccessToken: AccessTokenProvider,
  payload: { email: string; displayName: string; handle: string; role?: 'admin' | 'member' },
): Promise<User> {
  const data = await apiRequest<{ user: unknown }>('/api/admin/users', {
    method: 'POST',
    body: payload,
    getAccessToken,
  });
  return UserSchema.parse(data.user);
}

export async function fetchAgentConnections(
  getAccessToken: AccessTokenProvider,
  signal?: AbortSignal,
): Promise<AgentConnection[]> {
  const data = await apiRequest<{ connections: unknown }>('/api/agent-connections', {
    getAccessToken,
    signal,
  });
  return AgentConnectionSchema.array().parse(data.connections);
}

export async function createAgentConnection(
  getAccessToken: AccessTokenProvider,
  platform: string,
): Promise<{ connection: AgentConnection; apiKey: string }> {
  const data = await apiRequest<{ connection: unknown; apiKey: string }>('/api/agent-connections', {
    method: 'POST',
    body: { platform },
    getAccessToken,
  });
  return {
    connection: AgentConnectionSchema.parse(data.connection),
    apiKey: data.apiKey,
  };
}

export async function rotateAgentConnection(
  getAccessToken: AccessTokenProvider,
  connectionId: string,
): Promise<{ connection: AgentConnection; apiKey: string }> {
  const data = await apiRequest<{ connection: unknown; apiKey: string }>(
    `/api/agent-connections/${encodeURIComponent(connectionId)}/rotate`,
    {
      method: 'POST',
      body: {},
      getAccessToken,
    },
  );
  return {
    connection: AgentConnectionSchema.parse(data.connection),
    apiKey: data.apiKey,
  };
}

export async function revokeAgentConnection(
  getAccessToken: AccessTokenProvider,
  connectionId: string,
): Promise<AgentConnection> {
  const data = await apiRequest<{ connection: unknown }>(
    `/api/agent-connections/${encodeURIComponent(connectionId)}`,
    {
      method: 'DELETE',
      getAccessToken,
    },
  );
  return AgentConnectionSchema.parse(data.connection);
}

const isEmulatorFrontend = import.meta.env.VITE_AUTH_MODE === 'emulator';

function parseSubscriptionRecord(raw: unknown): Subscription {
  return isEmulatorFrontend ? SubscriptionEmulatorSchema.parse(raw) : SubscriptionSchema.parse(raw);
}

export interface CreateSubscriptionRequest {
  connectionId?: string | null;
  webhookUrl: string;
  authType: WebhookAuthType;
  secret: string;
  filters: Subscription['filters'];
  active?: boolean;
}

export interface UpdateSubscriptionRequest {
  webhookUrl?: string;
  authType?: WebhookAuthType;
  secret?: string;
  filters?: Subscription['filters'];
  active?: boolean;
}

export async function fetchSubscriptions(
  getAccessToken: AccessTokenProvider,
  signal?: AbortSignal,
): Promise<Subscription[]> {
  const data = await apiRequest<{ subscriptions: unknown[] }>('/api/subscriptions', {
    getAccessToken,
    signal,
  });
  return data.subscriptions.map(parseSubscriptionRecord);
}

export async function createSubscription(
  getAccessToken: AccessTokenProvider,
  payload: CreateSubscriptionRequest,
): Promise<Subscription> {
  const data = await apiRequest<{ subscription: unknown }>('/api/subscriptions', {
    method: 'POST',
    body: payload,
    getAccessToken,
  });
  return parseSubscriptionRecord(data.subscription);
}

export async function updateSubscription(
  getAccessToken: AccessTokenProvider,
  subscriptionId: string,
  payload: UpdateSubscriptionRequest,
): Promise<Subscription> {
  const data = await apiRequest<{ subscription: unknown }>(
    `/api/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: 'PATCH',
      body: payload,
      getAccessToken,
    },
  );
  return parseSubscriptionRecord(data.subscription);
}

export async function deleteSubscription(
  getAccessToken: AccessTokenProvider,
  subscriptionId: string,
): Promise<{ deleted: true; id: string }> {
  return apiRequest<{ deleted: true; id: string }>(
    `/api/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: 'DELETE',
      getAccessToken,
    },
  );
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
