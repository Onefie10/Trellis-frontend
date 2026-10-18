import { useEffect } from "react";
import { useHasHydrated } from "@/store/persistence";
import { useSearchStore } from "@/store/searchStore";

export const useSearch = (initialQuery = "", initialFilters = {}) => {
  const { query, filters, results, loading, error, setQuery, setFilters, fetchSearchResults } =
    useSearchStore();
  const hasHydrated = useHasHydrated(useSearchStore);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    if (initialQuery) {
      setQuery(initialQuery);
    }
    if (Object.keys(initialFilters).length > 0) {
      setFilters(initialFilters as Record<string, string | number | boolean>);
    }
  }, [hasHydrated, initialFilters, initialQuery, setFilters, setQuery]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    const debouncedSearch = window.setTimeout(() => {
      void fetchSearchResults({ query, filters });
    }, 300);

    return () => {
      window.clearTimeout(debouncedSearch);
    };
  }, [fetchSearchResults, filters, hasHydrated, query]);

  return { query, setQuery, filters, setFilters, results, loading, error };
};
