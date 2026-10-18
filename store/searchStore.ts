import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { searchAgents } from '@/features/agent-discovery/services/searchService';
import { createPersistStorage } from './persistence';

type SearchFilters = Record<string, string | number | boolean>;

interface SearchState {
  query: string;
  filters: SearchFilters;
  results: any[];
  loading: boolean;
  error: string | null;
  hasHydrated: boolean;
}

interface SearchActions {
  setQuery: (query: string) => void;
  setFilters: (filters: SearchFilters) => void;
  setHydrated: (hydrated: boolean) => void;
  fetchSearchResults: (params: {
    query: string;
    filters: SearchFilters;
  }) => Promise<void>;
}

export type SearchStore = SearchState & SearchActions;

const initialSearchState: SearchState = {
  query: '',
  filters: {},
  results: [],
  loading: false,
  error: null,
  hasHydrated: false,
};

export const useSearchStore = create<SearchStore>()(
  persist(
    (set) => ({
      ...initialSearchState,
      setQuery: (query) => set({ query }),
      setFilters: (filters) => set({ filters }),
      setHydrated: (hydrated) => set({ hasHydrated: hydrated }),
      fetchSearchResults: async ({ query, filters }) => {
        set({ loading: true, error: null });
        try {
          const results = await searchAgents(query, filters);
          set({ results, loading: false });
        } catch (error) {
          set({
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : 'An unknown error occurred',
          });
        }
      },
    }),
    {
      name: 'trellis-search-store',
      version: 1,
      storage: createPersistStorage(),
      partialize: (state) => ({
        query: state.query,
        filters: state.filters,
        results: state.results,
      }),
      migrate: (persistedState, version) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return initialSearchState;
        }

        const state = persistedState as Partial<SearchState>;
        const nextState: SearchState = {
          query: typeof state.query === 'string' ? state.query : '',
          filters:
            state.filters && typeof state.filters === 'object'
              ? (state.filters as SearchFilters)
              : {},
          results: Array.isArray(state.results) ? state.results : [],
          loading: false,
          error: null,
          hasHydrated: false,
        };

        if (version <= 0) {
          return nextState;
        }

        return nextState;
      },
      onRehydrateStorage: () => () => {
        useSearchStore.setState({ hasHydrated: true });
      },
    },
  ),
);
