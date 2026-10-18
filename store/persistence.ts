import { useEffect, useState } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';
import { createJSONStorage, type StateStorage } from 'zustand/middleware';

export interface HydratableState {
  hasHydrated?: boolean;
}

export const createSafeStorage = (): StateStorage => ({
  getItem: (name) => {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      return window.localStorage.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(name, value);
    } catch {
      // Ignore quota or browser storage errors during hydration.
    }
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.removeItem(name);
    } catch {
      // Ignore storage removal errors.
    }
  },
});

export const createPersistStorage = () =>
  createJSONStorage(() => createSafeStorage());

export function useHasHydrated<T extends HydratableState>(
  useStore: UseBoundStore<StoreApi<T>>,
): boolean {
  const hydrated = useStore((state) => Boolean(state.hasHydrated));
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  return hasMounted && hydrated;
}
