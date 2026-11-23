import { useEffect } from 'react';
import { APP_NAME, type User } from '@agent-kanban/shared';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAppAuth } from '../lib/auth.js';

interface TabConfig {
  to: string;
  label: string;
  title: string;
  summary: string;
}

const TABS: readonly TabConfig[] = [
  {
    to: '/',
    label: 'To-Do',
    title: 'To-Do',
    summary: 'Your AI-prioritized Top 5 queue will appear here in Milestone 1.',
  },
  {
    to: '/active',
    label: 'Active',
    title: 'Active',
    summary: 'In-progress and blocked household cards will appear here in Milestone 1.',
  },
  {
    to: '/done',
    label: 'Done',
    title: 'Done',
    summary: 'Recently completed cards before auto-archiving will appear here in Milestone 1.',
  },
  {
    to: '/settings',
    label: 'Settings',
    title: 'Settings',
    summary: 'Agent connections, API keys, webhooks, and household roster settings.',
  },
] as const;

function PlaceholderSection({
  heading,
  summary,
  user,
}: {
  heading: string;
  summary: string;
  user: User;
}) {
  return (
    <section className="space-y-4">
      <h1 id="main-content" tabIndex={-1} className="text-2xl font-semibold tracking-tight">
        {heading}
      </h1>
      <p className="text-sm text-slate-600">{summary}</p>

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
    </section>
  );
}

export interface AppShellProps {
  user: User;
}

export function AppShell({ user }: AppShellProps) {
  const { mode, signOut } = useAppAuth();
  const location = useLocation();

  useEffect(() => {
    const activeTab = TABS.find((tab) => tab.to === location.pathname) ?? TABS[0];
    document.title = `${activeTab?.title ?? 'Home'} | ${APP_NAME}`;
  }, [location.pathname]);

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50 text-slate-900">
      <a
        href="#main-content"
        className="visually-hidden fixed top-2 left-2 z-50 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow"
      >
        Skip to main content
      </a>

      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/icon.svg" alt="" width={28} height={28} className="h-7 w-7 rounded-lg" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{APP_NAME}</p>
              <p className="truncate text-xs text-slate-600">
                {user.displayName} (@{user.handle})
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {mode === 'emulator' ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                Emulator
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void signOut();
              }}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-xl flex-1 px-4 pt-6 pb-24">
        <Routes>
          <Route
            path="/"
            element={<PlaceholderSection heading="To-Do" summary={TABS[0]!.summary} user={user} />}
          />
          <Route
            path="/active"
            element={<PlaceholderSection heading="Active" summary={TABS[1]!.summary} user={user} />}
          />
          <Route
            path="/done"
            element={<PlaceholderSection heading="Done" summary={TABS[2]!.summary} user={user} />}
          />
          <Route
            path="/settings"
            element={
              <PlaceholderSection heading="Settings" summary={TABS[3]!.summary} user={user} />
            }
          />
          <Route
            path="*"
            element={<PlaceholderSection heading="To-Do" summary={TABS[0]!.summary} user={user} />}
          />
        </Routes>
      </main>

      <nav
        aria-label="Primary"
        className="fixed right-0 bottom-0 left-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur"
      >
        <ul className="mx-auto grid w-full max-w-xl grid-cols-4">
          {TABS.map((tab) => (
            <li key={tab.to}>
              <NavLink
                to={tab.to}
                end={tab.to === '/'}
                className={({ isActive }) =>
                  [
                    'flex min-h-14 items-center justify-center text-xs font-semibold transition',
                    isActive
                      ? 'border-t-2 border-sky-600 text-sky-700'
                      : 'border-t-2 border-transparent text-slate-600 hover:text-slate-900',
                  ].join(' ')
                }
              >
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
