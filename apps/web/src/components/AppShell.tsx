import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { APP_NAME, type User } from '@agent-kanban/shared';
import { CheckCircle2, Flame, ListTodo, Plus, Settings, type LucideIcon } from 'lucide-react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { fetchHouseholdUsers } from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';
import { ActivePage } from '../pages/ActivePage.js';
import { CardDetailPage } from '../pages/CardDetailPage.js';
import { DonePage } from '../pages/DonePage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { TodoPage } from '../pages/TodoPage.js';
import { OfflineBanner } from './OfflineBanner.js';
import { QuickAddModal } from './QuickAddModal.js';

interface TabConfig {
  to: string;
  label: string;
  title: string;
  icon: LucideIcon;
}

const TABS: readonly TabConfig[] = [
  { to: '/', label: 'To-Do', title: 'To-Do', icon: ListTodo },
  { to: '/active', label: 'Active', title: 'Active', icon: Flame },
  { to: '/done', label: 'Done', title: 'Done', icon: CheckCircle2 },
  { to: '/settings', label: 'Settings', title: 'Settings', icon: Settings },
] as const;

export interface AppShellProps {
  user: User;
}

export function AppShell({ user }: AppShellProps) {
  const { mode, signOut, getAccessToken } = useAppAuth();
  const location = useLocation();
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => fetchHouseholdUsers(getAccessToken, signal),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (location.pathname.startsWith('/cards/')) {
      document.title = `Card Detail | ${APP_NAME}`;
      return;
    }
    const activeTab = TABS.find((tab) => tab.to === location.pathname) ?? TABS[0];
    document.title = `${activeTab?.title ?? 'Home'} | ${APP_NAME}`;
  }, [location.pathname]);

  const showFab =
    location.pathname === '/' || location.pathname === '/active' || location.pathname === '/done';

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50 text-slate-900">
      <a
        href="#main-content"
        className="visually-hidden fixed top-[calc(0.5rem+var(--safe-area-top))] left-[calc(0.5rem+var(--safe-area-left))] z-50 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow"
      >
        Skip to main content
      </a>

      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white pt-[var(--safe-area-top)] pr-[var(--safe-area-right)] pl-[var(--safe-area-left)]">
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

      <OfflineBanner />

      <main className="mx-auto w-full max-w-xl flex-1 px-4 pt-6 pb-[calc(6rem+var(--safe-area-bottom))]">
        <Routes>
          <Route path="/" element={<TodoPage user={user} />} />
          <Route path="/active" element={<ActivePage user={user} />} />
          <Route path="/done" element={<DonePage user={user} />} />
          <Route path="/settings" element={<SettingsPage user={user} />} />
          <Route path="/cards/:id" element={<CardDetailPage user={user} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>

        <p className="mt-8 border-t border-slate-200 pt-4 text-center text-xs text-slate-500">
          Signed in as {user.displayName} ({user.email})
        </p>
      </main>

      {showFab ? (
        <button
          type="button"
          aria-label="New card"
          onClick={() => setQuickAddOpen(true)}
          className="fixed right-[max(1rem,var(--safe-area-right))] bottom-[calc(5rem+var(--safe-area-bottom))] z-30 flex h-14 w-14 items-center justify-center rounded-full bg-sky-700 text-white shadow-lg transition hover:bg-sky-800 active:scale-95 sm:right-[max(2rem,var(--safe-area-right))]"
        >
          <Plus className="h-6 w-6 shrink-0" strokeWidth={2.5} aria-hidden="true" />
        </button>
      ) : null}

      <QuickAddModal
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        currentUser={user}
        users={usersQuery.data ?? [user]}
      />

      <nav
        aria-label="Primary"
        className="fixed right-0 bottom-0 left-0 z-20 border-t border-slate-200 bg-white/95 pr-[var(--safe-area-right)] pb-[var(--safe-area-bottom)] pl-[var(--safe-area-left)] backdrop-blur"
      >
        <ul className="mx-auto grid w-full max-w-xl grid-cols-4">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <li key={tab.to}>
                <NavLink
                  to={tab.to}
                  end={tab.to === '/'}
                  className={({ isActive }) =>
                    [
                      'flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition',
                      isActive
                        ? 'border-t-2 border-sky-600 text-sky-700'
                        : 'border-t-2 border-transparent text-slate-600 hover:text-slate-900',
                    ].join(' ')
                  }
                >
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>{tab.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
