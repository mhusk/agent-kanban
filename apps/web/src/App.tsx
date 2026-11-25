import { useEffect } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AccessDeniedView } from './components/AccessDeniedView.js';
import { AppShell } from './components/AppShell.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { SignInView } from './components/SignInView.js';
import { fetchCurrentUser, isApiError } from './lib/api.js';
import { AppAuthProvider, useAppAuth } from './lib/auth.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <main className="text-center">
        <div
          role="progressbar"
          aria-label={label}
          className="mx-auto h-8 w-8 animate-spin rounded-full border-3 border-slate-300 border-t-sky-600"
        />
        <p className="mt-3 text-sm text-slate-600">{label}</p>
      </main>
    </div>
  );
}

function AuthenticatedGate() {
  const { isLoading, isAuthenticated, providerEmail, getAccessToken, signOut } = useAppAuth();

  const meQuery = useQuery({
    queryKey: ['me', providerEmail ?? 'anonymous'],
    queryFn: ({ signal }) => fetchCurrentUser(getAccessToken, signal),
    enabled: isAuthenticated && !isLoading,
  });

  useEffect(() => {
    if (isApiError(meQuery.error) && meQuery.error.status === 401) {
      void signOut();
    }
  }, [meQuery.error, signOut]);

  if (isLoading) {
    return <LoadingScreen label="Checking session…" />;
  }

  if (!isAuthenticated) {
    return <SignInView />;
  }

  if (meQuery.isPending) {
    return <LoadingScreen label="Loading household profile…" />;
  }

  if (meQuery.error) {
    if (isApiError(meQuery.error) && meQuery.error.status === 403) {
      return (
        <AccessDeniedView
          email={providerEmail}
          reason={meQuery.error.message}
          onSignOut={signOut}
        />
      );
    }

    if (isApiError(meQuery.error) && meQuery.error.status === 401) {
      return <LoadingScreen label="Session expired, signing out…" />;
    }

    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
        <main className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">Unable to load profile</h1>
          <p role="alert" className="mt-2 text-sm text-rose-700">
            {meQuery.error instanceof Error
              ? meQuery.error.message
              : 'An unexpected error occurred while contacting the API.'}
          </p>
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={() => {
                void meQuery.refetch();
              }}
              className="min-h-11 flex-1 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => {
                void signOut();
              }}
              className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <AppShell user={meQuery.data} />
    </ErrorBoundary>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppAuthProvider>
          <AuthenticatedGate />
        </AppAuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
