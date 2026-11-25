import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EventTypeSchema,
  type EventType,
  type Subscription,
  type User,
  type UserRole,
  type WebhookAuthType,
} from '@agent-kanban/shared';
import {
  createAgentConnection,
  createHouseholdUser,
  createSubscription,
  deleteSubscription,
  fetchAgentConnections,
  fetchHouseholdUsers,
  fetchSubscriptions,
  isApiError,
  revokeAgentConnection,
  rotateAgentConnection,
  updateSubscription,
} from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';

const ALL_EVENT_TYPES: readonly EventType[] = EventTypeSchema.options;

function formatShortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(ms));
}

export function SettingsPage({ user }: { user: User }) {
  const { getAccessToken, signOut } = useAppAuth();
  const queryClient = useQueryClient();

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => fetchHouseholdUsers(getAccessToken, signal),
    staleTime: 60_000,
  });

  const connectionsQuery = useQuery({
    queryKey: ['agent-connections', user.id],
    queryFn: ({ signal }) => fetchAgentConnections(getAccessToken, signal),
  });

  const subscriptionsQuery = useQuery({
    queryKey: ['subscriptions', user.id],
    queryFn: ({ signal }) => fetchSubscriptions(getAccessToken, signal),
  });

  // Add household member form (admin only)
  const [memberName, setMemberName] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberHandle, setMemberHandle] = useState('');
  const [memberRole, setMemberRole] = useState<UserRole>('member');
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberSaved, setMemberSaved] = useState<string | null>(null);

  // Create agent connection form
  const [platformName, setPlatformName] = useState('');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    id: string;
    kind: 'rotate' | 'revoke';
  } | null>(null);

  // Copy-once key reveal modal
  const revealDialogRef = useRef<HTMLDialogElement>(null);
  const [revealedKeyInfo, setRevealedKeyInfo] = useState<{
    platform: string;
    apiKey: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Webhook subscriptions state
  const [showWebhookForm, setShowWebhookForm] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookAuthType, setWebhookAuthType] = useState<WebhookAuthType>('hmac');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookTagsInput, setWebhookTagsInput] = useState('');
  const [selectedEventTypes, setSelectedEventTypes] = useState<EventType[]>(['card.created']);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [confirmDeleteSubId, setConfirmDeleteSubId] = useState<string | null>(null);

  useEffect(() => {
    const dialog = revealDialogRef.current;
    if (!dialog) {
      return;
    }
    if (revealedKeyInfo !== null) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [revealedKeyInfo]);

  const addMemberMutation = useMutation({
    mutationFn: () =>
      createHouseholdUser(getAccessToken, {
        displayName: memberName.trim(),
        email: memberEmail.trim(),
        handle: memberHandle.trim(),
        role: memberRole,
      }),
    onSuccess: (created) => {
      setMemberName('');
      setMemberEmail('');
      setMemberHandle('');
      setMemberRole('member');
      setMemberError(null);
      setMemberSaved(`Added ${created.displayName} (@${created.handle}).`);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => {
      setMemberSaved(null);
      setMemberError(isApiError(err) ? err.message : 'Unable to add household member.');
    },
  });

  const createConnectionMutation = useMutation({
    mutationFn: (platform: string) => createAgentConnection(getAccessToken, platform),
    onSuccess: (result) => {
      setPlatformName('');
      setConnectionError(null);
      setCopied(false);
      setRevealedKeyInfo({
        platform: result.connection.platform,
        apiKey: result.apiKey,
      });
      void queryClient.invalidateQueries({ queryKey: ['agent-connections', user.id] });
    },
    onError: (err) => {
      setConnectionError(isApiError(err) ? err.message : 'Unable to create agent connection.');
    },
  });

  const rotateConnectionMutation = useMutation({
    mutationFn: (connectionId: string) => rotateAgentConnection(getAccessToken, connectionId),
    onSuccess: (result) => {
      setConfirmAction(null);
      setConnectionError(null);
      setCopied(false);
      setRevealedKeyInfo({
        platform: result.connection.platform,
        apiKey: result.apiKey,
      });
      void queryClient.invalidateQueries({ queryKey: ['agent-connections', user.id] });
    },
    onError: (err) => {
      setConfirmAction(null);
      setConnectionError(isApiError(err) ? err.message : 'Unable to rotate API key.');
    },
  });

  const revokeConnectionMutation = useMutation({
    mutationFn: (connectionId: string) => revokeAgentConnection(getAccessToken, connectionId),
    onSuccess: () => {
      setConfirmAction(null);
      setConnectionError(null);
      void queryClient.invalidateQueries({ queryKey: ['agent-connections', user.id] });
    },
    onError: (err) => {
      setConfirmAction(null);
      setConnectionError(isApiError(err) ? err.message : 'Unable to revoke API key.');
    },
  });

  const createSubscriptionMutation = useMutation({
    mutationFn: (payload: {
      webhookUrl: string;
      authType: WebhookAuthType;
      secret: string;
      tags: string[];
      eventTypes: EventType[];
    }) =>
      createSubscription(getAccessToken, {
        webhookUrl: payload.webhookUrl,
        authType: payload.authType,
        secret: payload.secret,
        filters: {
          eventTypes: payload.eventTypes,
          ...(payload.tags.length > 0 ? { tags: payload.tags } : {}),
        },
        active: true,
      }),
    onSuccess: () => {
      setWebhookUrl('');
      setWebhookSecret('');
      setWebhookTagsInput('');
      setWebhookAuthType('hmac');
      setSelectedEventTypes(['card.created']);
      setWebhookError(null);
      setShowWebhookForm(false);
      void queryClient.invalidateQueries({ queryKey: ['subscriptions', user.id] });
    },
    onError: (err) => {
      setWebhookError(isApiError(err) ? err.message : 'Unable to save webhook subscription.');
    },
  });

  const toggleSubscriptionMutation = useMutation({
    mutationFn: (sub: Subscription) =>
      updateSubscription(getAccessToken, sub.id, { active: !sub.active }),
    onSuccess: () => {
      setWebhookError(null);
      void queryClient.invalidateQueries({ queryKey: ['subscriptions', user.id] });
    },
    onError: (err) => {
      setWebhookError(isApiError(err) ? err.message : 'Unable to update webhook status.');
    },
  });

  const deleteSubscriptionMutation = useMutation({
    mutationFn: (subscriptionId: string) => deleteSubscription(getAccessToken, subscriptionId),
    onSuccess: () => {
      setConfirmDeleteSubId(null);
      setWebhookError(null);
      void queryClient.invalidateQueries({ queryKey: ['subscriptions', user.id] });
    },
    onError: (err) => {
      setConfirmDeleteSubId(null);
      setWebhookError(isApiError(err) ? err.message : 'Unable to delete webhook subscription.');
    },
  });

  const handleAddMember = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMemberError(null);
    setMemberSaved(null);
    addMemberMutation.mutate();
  };

  const handleCreateConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = platformName.trim();
    if (!trimmed) {
      setConnectionError('Platform name is required.');
      return;
    }
    setConnectionError(null);
    createConnectionMutation.mutate(trimmed);
  };

  const handleToggleEventType = (eventType: EventType) => {
    setSelectedEventTypes((prev) =>
      prev.includes(eventType) ? prev.filter((item) => item !== eventType) : [...prev, eventType],
    );
  };

  const handleCreateSubscription = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedEventTypes.length === 0) {
      setWebhookError('Select at least one event type.');
      return;
    }
    const tags = webhookTagsInput
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    setWebhookError(null);
    createSubscriptionMutation.mutate({
      webhookUrl: webhookUrl.trim(),
      authType: webhookAuthType,
      secret: webhookSecret,
      tags,
      eventTypes: selectedEventTypes,
    });
  };

  const handleCopyKey = async () => {
    if (!revealedKeyInfo) {
      return;
    }
    try {
      await navigator.clipboard.writeText(revealedKeyInfo.apiKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const users = usersQuery.data ?? [];
  const connections = connectionsQuery.data ?? [];
  const subscriptions = subscriptionsQuery.data ?? [];

  return (
    <section className="space-y-5">
      <h1 id="main-content" tabIndex={-1} className="text-2xl font-semibold tracking-tight">
        Settings
      </h1>

      {/* Profile & Sign Out */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
            Profile &amp; Session
          </h2>
          <button
            type="button"
            onClick={() => {
              void signOut();
            }}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100"
          >
            Log out
          </button>
        </div>

        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-slate-500">Name</dt>
            <dd className="font-medium text-slate-900">{user.displayName}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Handle</dt>
            <dd className="font-medium text-slate-900">@{user.handle}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Email</dt>
            <dd className="font-medium break-all text-slate-900">{user.email}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Role</dt>
            <dd className="font-medium text-slate-900 capitalize">{user.role}</dd>
          </div>
        </dl>
      </div>

      {/* Household Roster */}
      <section
        aria-labelledby="roster-heading"
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"
      >
        <h2
          id="roster-heading"
          className="text-sm font-semibold tracking-wide text-slate-500 uppercase"
        >
          Household Roster ({users.length})
        </h2>

        {usersQuery.isPending ? (
          <p className="text-xs text-slate-500">Loading household members…</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {users.map((member) => (
              <li
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">
                    {member.displayName}{' '}
                    <span className="text-xs font-normal text-slate-500">@{member.handle}</span>
                  </p>
                  <p className="truncate text-xs text-slate-500">{member.email}</p>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 capitalize">
                  {member.role}
                </span>
              </li>
            ))}
          </ul>
        )}

        {user.role === 'admin' ? (
          <form onSubmit={handleAddMember} className="space-y-3 border-t border-slate-100 pt-4">
            <h3 className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
              Add household member
            </h3>

            {memberError ? (
              <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
                {memberError}
              </p>
            ) : null}
            {memberSaved ? (
              <p
                role="status"
                className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900"
              >
                {memberSaved}
              </p>
            ) : null}

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div>
                <label htmlFor="member-name" className="block text-xs font-medium text-slate-700">
                  Display name
                </label>
                <input
                  id="member-name"
                  type="text"
                  required
                  value={memberName}
                  onChange={(event) => setMemberName(event.target.value)}
                  placeholder="Taylor Rivera"
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="member-email" className="block text-xs font-medium text-slate-700">
                  Email
                </label>
                <input
                  id="member-email"
                  type="email"
                  required
                  value={memberEmail}
                  onChange={(event) => setMemberEmail(event.target.value)}
                  placeholder="taylor@example.test"
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="member-handle" className="block text-xs font-medium text-slate-700">
                  Handle
                </label>
                <input
                  id="member-handle"
                  type="text"
                  required
                  value={memberHandle}
                  onChange={(event) => setMemberHandle(event.target.value)}
                  placeholder="taylor"
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="member-role" className="block text-xs font-medium text-slate-700">
                  Role
                </label>
                <select
                  id="member-role"
                  value={memberRole}
                  onChange={(event) => setMemberRole(event.target.value as UserRole)}
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={addMemberMutation.isPending}
                className="min-h-11 rounded-xl bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {addMemberMutation.isPending ? 'Adding…' : 'Add member'}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {/* Agent Connections (API Keys) */}
      <section
        aria-labelledby="agent-connections-heading"
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"
      >
        <div>
          <h2
            id="agent-connections-heading"
            className="text-sm font-semibold tracking-wide text-slate-500 uppercase"
          >
            Agent Connections (API Keys)
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Keys inherit your card visibility. Send{' '}
            <code className="rounded bg-slate-100 px-1">X-Agent-Name</code> to attribute actions to
            a specific assistant.
          </p>
        </div>

        {connectionError ? (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {connectionError}
          </p>
        ) : null}

        <form onSubmit={handleCreateConnection} className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            aria-label="Platform name"
            placeholder="Platform name (e.g., Automation Bot)"
            value={platformName}
            onChange={(event) => setPlatformName(event.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm"
          />
          <button
            type="submit"
            disabled={createConnectionMutation.isPending}
            className="min-h-11 shrink-0 rounded-xl bg-sky-700 px-4 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-60"
          >
            {createConnectionMutation.isPending ? 'Creating…' : 'Create API key'}
          </button>
        </form>

        {connectionsQuery.isPending ? (
          <p className="text-xs text-slate-500">Loading agent connections…</p>
        ) : connections.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500">
            No agent connections yet.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {connections.map((conn) => {
              const isConfirmingRotate =
                confirmAction?.id === conn.id && confirmAction.kind === 'rotate';
              const isConfirmingRevoke =
                confirmAction?.id === conn.id && confirmAction.kind === 'revoke';

              return (
                <li
                  key={conn.id}
                  className="space-y-2 rounded-xl border border-slate-200 p-3.5 text-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{conn.platform}</p>
                      <p className="mt-0.5 text-xs text-slate-600">
                        <code className="rounded bg-slate-100 px-1.5 py-0.5">
                          {conn.keyPrefix ? `${conn.keyPrefix}…` : 'OAuth'}
                        </code>{' '}
                        · Created {formatShortDate(conn.createdAt)}
                        {conn.rotatedAt ? ` · Rotated ${formatShortDate(conn.rotatedAt)}` : ''}
                      </p>
                    </div>

                    <span
                      className={[
                        'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                        conn.revoked
                          ? 'bg-rose-100 text-rose-800'
                          : 'bg-emerald-100 text-emerald-900',
                      ].join(' ')}
                    >
                      {conn.revoked ? 'Revoked' : 'Active'}
                    </span>
                  </div>

                  {!conn.revoked ? (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {isConfirmingRotate ? (
                        <>
                          <button
                            type="button"
                            disabled={rotateConnectionMutation.isPending}
                            onClick={() => rotateConnectionMutation.mutate(conn.id)}
                            className="min-h-10 rounded-lg bg-amber-700 px-3 text-xs font-semibold text-white hover:bg-amber-800"
                          >
                            Confirm rotate
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmAction(null)}
                            className="min-h-10 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            Cancel
                          </button>
                        </>
                      ) : isConfirmingRevoke ? (
                        <>
                          <button
                            type="button"
                            disabled={revokeConnectionMutation.isPending}
                            onClick={() => revokeConnectionMutation.mutate(conn.id)}
                            className="min-h-10 rounded-lg bg-rose-700 px-3 text-xs font-semibold text-white hover:bg-rose-800"
                          >
                            Confirm revoke
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmAction(null)}
                            className="min-h-10 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setConfirmAction({ id: conn.id, kind: 'rotate' })}
                            className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-100"
                          >
                            Rotate
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmAction({ id: conn.id, kind: 'revoke' })}
                            className="min-h-10 rounded-lg border border-rose-200 bg-white px-3 text-xs font-medium text-rose-700 hover:bg-rose-50"
                          >
                            Revoke
                          </button>
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Webhook Subscriptions */}
      <section
        aria-labelledby="webhooks-heading"
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="webhooks-heading"
              className="text-sm font-semibold tracking-wide text-slate-500 uppercase"
            >
              Webhook Subscriptions
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              Filtered push notifications signed with Bearer or HMAC-SHA256. Agent actions never
              trigger webhooks.
            </p>
          </div>
          <button
            type="button"
            aria-expanded={showWebhookForm}
            aria-controls="add-webhook-form"
            onClick={() => {
              setWebhookError(null);
              setShowWebhookForm((prev) => !prev);
            }}
            className="min-h-11 shrink-0 rounded-xl border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 hover:bg-slate-100"
          >
            {showWebhookForm ? 'Cancel' : 'Add webhook'}
          </button>
        </div>

        {webhookError ? (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {webhookError}
          </p>
        ) : null}

        {showWebhookForm ? (
          <form
            id="add-webhook-form"
            aria-labelledby="add-webhook-heading"
            onSubmit={handleCreateSubscription}
            className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
          >
            <h3
              id="add-webhook-heading"
              className="text-xs font-semibold tracking-wide text-slate-700 uppercase"
            >
              New webhook subscription
            </h3>

            <div>
              <label htmlFor="webhook-url" className="block text-xs font-medium text-slate-700">
                Webhook URL
              </label>
              <input
                id="webhook-url"
                name="webhookUrl"
                type="url"
                required
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://hooks.example.test/kanban"
                value={webhookUrl}
                onChange={(event) => setWebhookUrl(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base sm:text-sm"
              />
            </div>

            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium text-slate-700">Auth type</legend>
              <div className="flex flex-wrap gap-4 pt-0.5">
                <label className="inline-flex min-h-10 items-center gap-2 text-xs font-medium text-slate-800">
                  <input
                    type="radio"
                    name="webhookAuthType"
                    value="hmac"
                    checked={webhookAuthType === 'hmac'}
                    onChange={() => setWebhookAuthType('hmac')}
                    className="h-4 w-4 accent-sky-700"
                  />
                  <span>HMAC-SHA256</span>
                </label>
                <label className="inline-flex min-h-10 items-center gap-2 text-xs font-medium text-slate-800">
                  <input
                    type="radio"
                    name="webhookAuthType"
                    value="bearer"
                    checked={webhookAuthType === 'bearer'}
                    onChange={() => setWebhookAuthType('bearer')}
                    className="h-4 w-4 accent-sky-700"
                  />
                  <span>Bearer token</span>
                </label>
              </div>
            </fieldset>

            <div>
              <label htmlFor="webhook-secret" className="block text-xs font-medium text-slate-700">
                Signing secret
              </label>
              <input
                id="webhook-secret"
                name="secret"
                type="password"
                required
                minLength={16}
                autoComplete="new-password"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="webhook-secret-help"
                value={webhookSecret}
                onChange={(event) => setWebhookSecret(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base sm:text-sm"
              />
              <p id="webhook-secret-help" className="mt-1 text-xs text-slate-500">
                At least 16 characters; encrypted at rest with AES-256-GCM.
              </p>
            </div>

            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium text-slate-700">Event types</legend>
              <div className="grid grid-cols-1 gap-1.5 pt-0.5 sm:grid-cols-2">
                {ALL_EVENT_TYPES.map((eventType) => {
                  const checkboxId = `evt-${eventType}`;
                  return (
                    <div key={eventType} className="flex min-h-10 items-center gap-2">
                      <input
                        id={checkboxId}
                        type="checkbox"
                        name="eventTypes"
                        value={eventType}
                        checked={selectedEventTypes.includes(eventType)}
                        onChange={() => handleToggleEventType(eventType)}
                        className="h-4 w-4 accent-sky-700"
                      />
                      <label htmlFor={checkboxId} className="font-mono text-xs text-slate-800">
                        {eventType}
                      </label>
                    </div>
                  );
                })}
              </div>
            </fieldset>

            <div>
              <label htmlFor="webhook-tags" className="block text-xs font-medium text-slate-700">
                Tags (optional, comma-separated)
              </label>
              <input
                id="webhook-tags"
                name="tags"
                type="text"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="groceries, home"
                value={webhookTagsInput}
                onChange={(event) => setWebhookTagsInput(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base sm:text-sm"
              />
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={createSubscriptionMutation.isPending}
                className="min-h-11 rounded-xl bg-sky-700 px-4 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-60"
              >
                {createSubscriptionMutation.isPending ? 'Saving…' : 'Save webhook'}
              </button>
            </div>
          </form>
        ) : null}

        {subscriptionsQuery.isPending ? (
          <p className="text-xs text-slate-500">Loading webhook subscriptions…</p>
        ) : subscriptions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500">
            No webhook subscriptions configured yet.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {subscriptions.map((sub) => {
              const isConfirmingDelete = confirmDeleteSubId === sub.id;

              return (
                <li
                  key={sub.id}
                  className="space-y-2.5 rounded-xl border border-slate-200 p-3.5 text-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs font-semibold break-all text-slate-900">
                        {sub.webhookUrl}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-700">
                          {sub.authType === 'hmac' ? 'HMAC' : 'Bearer'}
                        </span>{' '}
                        · Created {formatShortDate(sub.createdAt)}
                      </p>
                    </div>

                    <span
                      className={[
                        'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                        sub.active
                          ? 'bg-emerald-100 text-emerald-900'
                          : 'bg-slate-200 text-slate-700',
                      ].join(' ')}
                    >
                      {sub.active ? 'Active' : 'Paused'}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {sub.filters.eventTypes.map((evt) => (
                      <span
                        key={evt}
                        className="rounded-full bg-sky-50 px-2 py-0.5 font-mono text-[11px] font-medium text-sky-900"
                      >
                        {evt}
                      </span>
                    ))}
                    {sub.filters.tags?.map((tag) => (
                      <span
                        key={`tag-${tag}`}
                        className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900"
                      >
                        tag: {tag}
                      </span>
                    ))}
                    {sub.filters.statuses?.map((status) => (
                      <span
                        key={`status-${status}`}
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                      >
                        status: {status}
                      </span>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <button
                      type="button"
                      disabled={toggleSubscriptionMutation.isPending}
                      onClick={() => toggleSubscriptionMutation.mutate(sub)}
                      className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-100"
                    >
                      {sub.active ? 'Pause' : 'Enable'}
                    </button>

                    {isConfirmingDelete ? (
                      <>
                        <button
                          type="button"
                          disabled={deleteSubscriptionMutation.isPending}
                          onClick={() => deleteSubscriptionMutation.mutate(sub.id)}
                          className="min-h-10 rounded-lg bg-rose-700 px-3 text-xs font-semibold text-white hover:bg-rose-800"
                        >
                          Confirm delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteSubId(null)}
                          className="min-h-10 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteSubId(sub.id)}
                        className="min-h-10 rounded-lg border border-rose-200 bg-white px-3 text-xs font-medium text-rose-700 hover:bg-rose-50"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Copy-once API key reveal dialog */}
      <dialog
        ref={revealDialogRef}
        aria-labelledby="api-key-reveal-title"
        onClose={() => {
          if (revealDialogRef.current) {
            revealDialogRef.current.returnValue = '';
          }
          setRevealedKeyInfo(null);
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl"
      >
        {revealedKeyInfo ? (
          <div className="space-y-4">
            <h1 id="api-key-reveal-title" className="text-lg font-semibold text-slate-900">
              API key for {revealedKeyInfo.platform}
            </h1>
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Copy this API key now. For security, it will never be shown again after you close this
              dialog.
            </p>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <code
                data-testid="revealed-api-key"
                className="block font-mono text-xs break-all text-slate-900"
              >
                {revealedKeyInfo.apiKey}
              </code>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  void handleCopyKey();
                }}
                className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 hover:bg-slate-100"
              >
                {copied ? 'Copied' : 'Copy key'}
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => revealDialogRef.current?.close()}
                className="min-h-11 rounded-xl bg-slate-900 px-5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
