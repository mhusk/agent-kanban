import type { User } from '@agent-kanban/shared';

export function SettingsPage({ user }: { user: User }) {
  return (
    <section className="space-y-4">
      <h1 id="main-content" tabIndex={-1} className="text-2xl font-semibold tracking-tight">
        Settings
      </h1>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Signed-in Household Member
        </h2>
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
            <dd className="font-medium text-slate-900">{user.email}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Role</dt>
            <dd className="font-medium text-slate-900 capitalize">{user.role}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Agent Connections & Roster
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Household member management and user-owned agent API keys will appear here in Milestone 2.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Webhook Subscriptions
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Filtered webhook subscriptions and delivery status will appear here in Milestone 3.
        </p>
      </div>
    </section>
  );
}
