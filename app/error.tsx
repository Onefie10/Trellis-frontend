'use client';

import { useEffect, useRef } from 'react';

/**
 * Route-level error boundary.
 *
 * Catches render and effect errors thrown below the root layout, so a failing
 * page shows a recoverable fallback inside the normal navigation instead of
 * Next.js's blank "Application error" screen.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const retryButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    console.warn('Route error boundary caught an error', error.digest ?? error.message);
    retryButtonRef.current?.focus();
  }, [error]);

  return (
    <main
      data-testid="route-error-boundary"
      className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 py-16 text-center text-white"
    >
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="rounded-lg border border-red-500/50 bg-red-500/10 p-8"
      >
        <h1 className="text-2xl font-bold text-red-200">Something went wrong</h1>
        <p className="mt-2 text-sm text-gray-300">
          This page hit an unexpected error. It may be a temporary network problem.
        </p>
        <button
          ref={retryButtonRef}
          type="button"
          onClick={() => reset()}
          className="mt-6 rounded-md bg-trellis-leaf px-4 py-2 text-sm font-semibold text-black focus:outline-none focus:ring-2 focus:ring-trellis-leaf"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
