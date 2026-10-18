# Quota Management

## Overview
Trellis Frontend implements a quota management system to control expensive operations and prevent resource exhaustion. This is critical for preventing abuse, managing runaway costs, and maintaining service stability.

The Quota Manager is designed to enforce limits on resources such as storage, compute, external API quotas, and indexing capacity.

## Core Concepts

1. **Resources**: The system defines distinct resources (e.g., `compute`, `storage`, `external_api`, `indexing`).
2. **Quotas**: Each resource has a configured `defaultLimit`.
3. **Reset Windows**: Quotas can optionally have a `resetWindowMs`. For example, a compute quota could reset every hour.
4. **Overrides**: Maintainers can apply specific overrides for individual actors (e.g., power users or automated systems) using the `setOverride` method.

## Usage Guide

The quota system is implemented in `lib/quota-manager.ts`.

### Checking Quota
To safely check if an actor has enough quota for an operation without consuming it:

```typescript
import { quotaManager } from '@/lib/quota-manager';

if (quotaManager.check('user_123', 'compute', 10)) {
  // Safe to proceed
}
```

### Consuming Quota
To record usage, use `consume()`. If the limit is exceeded, it will throw a `QuotaExceededError`.

```typescript
try {
  quotaManager.consume('user_123', 'compute', 10);
  // Perform expensive operation
} catch (error) {
  if (error instanceof QuotaExceededError) {
    // Handle user-facing quota error gracefully
  }
}
```

### Maintainer Diagnostics
Maintainers can inspect usage for any actor and resource to aid in diagnostics:

```typescript
const stats = quotaManager.inspect('user_123', 'compute');
console.log(`Used: ${stats.used}/${stats.limit}`);
```

Overrides can be applied at runtime for exception handling:

```typescript
// Increase API limits for a specific integration
quotaManager.setOverride('partner_integration', 'external_api', 5000);
```

## Error Handling
When integrating the quota manager into API routes or UI actions, always catch `QuotaExceededError` and translate it into a user-friendly message (e.g., HTTP 429 Too Many Requests). Maintainer logs should capture these events for capacity planning.
