import { QueryClient } from '@tanstack/react-query';

/**
 * TanStack Query owns every piece of server state
 * (docs/architecture/frontend-architecture.md).
 *
 * Defaults are tuned for a mid-range Android on a mobile network: refetching on
 * every focus costs data the user is paying for, and a request that has already
 * failed twice is rarely fixed by a third attempt.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 2,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
