'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { classifyError, computeBackoffDelay, resolvePolicy } from '@/lib/retry';

/**
 * React Query's own `retry: 1` used an exponential backoff with no jitter and no
 * knowledge of which failures are worth retrying, so a 422 was replayed as often
 * as a 503. These two functions hand the decision to `@/lib/retry` so queries
 * follow the same policy as `lib/api.ts` and `lib/partial-failures.ts`.
 */
const QUERY_RETRY_POLICY = resolvePolicy('http_request');

export default function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            /** `failureCount` is 1-based, so the zero-based index is one less. */
            retry: (failureCount, error) => {
              if (failureCount > QUERY_RETRY_POLICY.maxRetries) return false;
              return classifyError(error).retryable;
            },
            retryDelay: (failureCount) =>
              computeBackoffDelay(failureCount - 1, QUERY_RETRY_POLICY),
          },
          mutations: {
            /** Mutations are not idempotent by default; opt in per call. */
            retry: false,
          },
        },
      })
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
