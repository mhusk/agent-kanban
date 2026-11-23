import { useEffect } from 'react';
import { APP_NAME } from '@agent-kanban/shared';
import { EMULATOR_DEV_USERS, useAppAuth } from '../lib/auth.js';

export function SignInView() {
  const { mode, isLoading, authError, signIn, signInAsEmulatorUser } = useAppAuth();

  useEffect(() => {
    document.title = `Sign in | ${APP_NAME}`;
  }, []);

  return (
    <div className="min-h-dvh bg-slate-50 px-4 py-12 text-slate-900">
      <main className="mx-auto w-full max-w-md">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex items-center gap-3">
            <img src="/icon.svg" alt="" width={40} height={40} className="h-10 w-10 rounded-xl" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">{APP_NAME}</h1>
              <p className="text-sm text-slate-600">Agent-first household task board</p>
            </div>
          </div>

          {authError ? (
            <div
              role="alert"
              className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
            >
              {authError}
            </div>
          ) : null}

          {mode === 'emulator' ? (
            <section aria-labelledby="dev-switcher-heading" className="mt-6">
              <div className="flex items-center justify-between gap-2">
                <h2
                  id="dev-switcher-heading"
                  className="text-sm font-semibold tracking-wide text-slate-700 uppercase"
                >
                  Dev User Switcher
                </h2>
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900">
                  Emulator Mode
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Sign in with a local RSA-signed emulator JWT against the seeded household roster.
              </p>

              <ul className="mt-4 space-y-2.5">
                {EMULATOR_DEV_USERS.map((preset) => (
                  <li key={preset.handle}>
                    <button
                      type="button"
                      disabled={isLoading}
                      onClick={() => {
                        void signInAsEmulatorUser({ handle: preset.handle });
                      }}
                      className="flex min-h-12 w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left transition hover:border-sky-300 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span>
                        <span className="block font-medium text-slate-900">
                          Sign in as {preset.displayName.split(' ')[0]} (@{preset.handle})
                        </span>
                        <span className="block text-xs text-slate-600">
                          {preset.displayName} · {preset.email}
                        </span>
                      </span>
                      <span className="rounded-md bg-slate-200/80 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {preset.roleLabel}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <div className="mt-5 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    void signInAsEmulatorUser({
                      email: 'outsider@example.test',
                      allowUnregistered: true,
                    });
                  }}
                  className="min-h-11 w-full rounded-xl border border-dashed border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Test unallowlisted account (403)
                </button>
              </div>
            </section>
          ) : (
            <section aria-labelledby="workos-signin-heading" className="mt-6">
              <h2 id="workos-signin-heading" className="text-base font-medium text-slate-900">
                Sign in to your household
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Access is limited to pre-approved household members via WorkOS AuthKit.
              </p>
              <button
                type="button"
                disabled={isLoading}
                onClick={() => {
                  void signIn();
                }}
                className="mt-5 min-h-11 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoading ? 'Redirecting…' : 'Sign in with WorkOS'}
              </button>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
