'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDebounce } from 'use-debounce';

export type MarketplaceSort = 'top' | 'newest' | 'rating';

export interface MarketplaceUrlState {
  query: string;
  categories: string[];
  sort: MarketplaceSort;
}

export const DEFAULT_MARKETPLACE_URL_STATE: MarketplaceUrlState = {
  query: '',
  categories: [],
  sort: 'top',
};

const VALID_SORTS: MarketplaceSort[] = ['top', 'newest', 'rating'];

export function parseMarketplaceUrlState(params: URLSearchParams): MarketplaceUrlState {
  const categories = [...new Set(
    (params.get('cat') ?? '')
      .split(',')
      .map((category) => category.trim().toLowerCase())
      .filter(Boolean),
  )];
  const sort = params.get('sort');

  return {
    query: params.get('q') ?? '',
    categories,
    sort: sort && VALID_SORTS.includes(sort as MarketplaceSort)
      ? (sort as MarketplaceSort)
      : DEFAULT_MARKETPLACE_URL_STATE.sort,
  };
}

/** Serialize marketplace filters while retaining query parameters owned by other features. */
export function serializeMarketplaceUrlState(
  state: MarketplaceUrlState,
  currentSearch = '',
): string {
  const params = new URLSearchParams(currentSearch);
  params.delete('q');
  params.delete('cat');
  params.delete('sort');

  if (state.query.trim()) params.set('q', state.query.trim());
  if (state.categories.length) {
    params.set('cat', [...new Set(state.categories)].sort().join(','));
  }
  params.set('sort', state.sort);

  // URLSearchParams escapes commas even though they are safe separators here.
  return params.toString().replace(/%2C/gi, ',');
}

/** Keep the UI and address bar in sync, writing one history entry per settled change. */
export function useMarketplaceUrlState() {
  const [state, setState] = useState(DEFAULT_MARKETPLACE_URL_STATE);
  const [debouncedState] = useDebounce(state, 250);

  useEffect(() => {
    const restoreFromLocation = () => {
      setState(parseMarketplaceUrlState(new URLSearchParams(window.location.search)));
    };

    restoreFromLocation();
    window.addEventListener('popstate', restoreFromLocation);
    return () => window.removeEventListener('popstate', restoreFromLocation);
  }, []);

  useEffect(() => {
    const search = serializeMarketplaceUrlState(
      debouncedState,
      window.location.search,
    );
    const nextUrl = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (nextUrl !== currentUrl) window.history.pushState(null, '', nextUrl);
  }, [debouncedState]);

  const update = useCallback((patch: Partial<MarketplaceUrlState>) => {
    setState((current) => ({ ...current, ...patch }));
  }, []);

  return { ...state, setQuery: (query: string) => update({ query }), update };
}
