# State management

Trellis uses **Zustand only**.

## Decision

Redux Toolkit and Zustand were both installed. Zustand is the single state
library because:

- Feature-scoped stores already live next to their feature
  (`features/affiliate-dashboard/store/useAffiliateStore.ts`,
  `store/useSimulationStore.ts`, `store/useBonusStore.ts`)
- No provider is required, which avoids the previous bug where the referral
  reducer existed in one store but the app mounted another
- Smaller API surface and bundle contribution

## Stores

| Store | Path | Used by |
| --- | --- | --- |
| Search | `store/searchStore.ts` | `features/agent-discovery/hooks/useSearch.ts` |
| API metrics | `store/apiMetricsStore.ts` | `lib/api.ts` |
| Referrals | `store/referralStore.ts` | `features/referral-sharing/` |
| Bonuses | `store/useBonusStore.ts` | `features/trading-bonuses/` |
| Simulations | `store/useSimulationStore.ts` | `app/simulations/`, `components/simulations/` |
| Affiliate | `features/affiliate-dashboard/store/useAffiliateStore.ts` | `features/affiliate-dashboard/` |

## Persistence and hydration safety

All persisted stores use the shared storage adapter in `store/persistence.ts` and expose a `hasHydrated` flag so client code waits until rehydration completes before rendering persisted values. This prevents SSR-to-client hydration mismatch warnings when local state is restored from `localStorage`.

Do not reintroduce `@reduxjs/toolkit` or `react-redux`.
