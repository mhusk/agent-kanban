import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error:', error, info);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
          <main className="w-full max-w-md space-y-4 rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
            <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
            <p role="alert" className="text-sm text-rose-800">
              {this.state.error.message || 'An unexpected rendering error occurred.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="min-h-11 rounded-xl bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-xs font-medium text-slate-800 hover:bg-slate-100"
              >
                Reload page
              </button>
            </div>
          </main>
        </div>
      );
    }

    return this.props.children;
  }
}
