import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { User, UserRole } from '@agent-kanban/shared';
import {
  createAgentConnection,
  createHouseholdUser,
  fetchAgentConnections,
  fetchHouseholdUsers,
  isApiError,
  revokeAgentConnection,
  rotateAgentConnection,
} from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';

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

      {/* Webhook Subscriptions placeholder (M3.4) */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Webhook Subscriptions
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Filtered webhook subscriptions and delivery status will appear here in Milestone 3.
        </p>
      </div>

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
