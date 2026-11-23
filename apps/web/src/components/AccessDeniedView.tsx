import { useEffect } from 'react';
import { APP_NAME } from '@agent-kanban/shared';

export interface AccessDeniedViewProps {
  email: string | null;
  reason?: string;
  onSignOut: () => Promise<void>;
}

export function AccessDeniedView({ email, reason, onSignOut }: AccessDeniedViewProps) {
  useEffect(() => {
    document.title = `Household access required | ${APP_NAME}`;
  }, []);

  return (
    <div className="min-h-dvh bg-slate-50 px-4 py-12 text-slate-900">
      <main className="mx-auto w-full max-w-md">
        <div className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-semibold tracking-wider text-amber-700 uppercase">
            Access Restricted (403)
          </p>
          <h1 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
            Household access required
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            {email ? (
              <>
                Your account <span className="font-medium text-slate-900">{email}</span> is not on
                the allowlist for this household workspace.
              </>
            ) : (
              'Your account is not on the allowlist for this household workspace.'
            )}
          </p>
          {reason ? (
            <p className="mt-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
              {reason}
            </p>
          ) : null}
          <p className="mt-3 text-sm text-slate-600">
            Ask a household admin to add your email address, then sign in again.
          </p>
          <button
            type="button"
            onClick={() => {
              void onSignOut();
            }}
            className="mt-6 min-h-11 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      </main>
    </div>
  );
}
