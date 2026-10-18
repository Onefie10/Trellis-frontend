# Privacy-Preserving Analytics

Maintainer analytics without exposing private user data, secrets, or sensitive payload content.

## Overview

The analytics system aggregates metrics on safe dimensions only, preventing accidental logging of:
- Passwords, API keys, tokens, secrets
- Wallet addresses, private keys
- Email addresses, phone numbers, SSNs
- User identifiable information
- Transaction payloads

## Configuration

```typescript
import { analyticsManager } from "@/lib/analytics";

analyticsManager.initialize({
  enabled: true,
  retentionDays: 90,
  samplingRate: 1.0,
  epsilon: 0.5,
  dailyPrivacyBudget: 2,
});
```

Client reports use a Laplace mechanism. Each release uses the configured `epsilon` (default `0.5`) and contributes to a daily browser-local budget (default `2`). The manager stops releasing batches when the budget is exhausted. Smaller epsilon means stronger noise; values are validated to remain between `0.1` and `10`.

Before sending, queued events are reduced to counts grouped only by allowlisted metric name and type. IDs, exact timestamps, raw values, dimensions, and metadata are omitted; timestamps are rounded to the UTC day. The dashboard's **Privacy protection audit** panel displays the active epsilon, remaining daily budget, and recent release decisions. The budget ledger is stored locally in the browser, so it is an operational client-side limit rather than a tamper-proof server-enforced account budget.

## Safe Metrics

All recordable metrics are defined in `lib/metric-definitions.ts`. Examples:

- `user.session_start` - User session started
- `transaction.completed` - Transaction succeeded
- `error.client_error` - Client-side error occurred
- `system.performance` - Performance measurement
- `feature.tutorial_started` - Feature tutorial started

## Recording Events

```typescript
import { analyticsManager } from "@/lib/analytics";

// Record event
analyticsManager.recordEvent("user.feature_used", {
  event_type: "claim_creation",
  feature: "claims",
  platform: "web",
});

// Record performance
analyticsManager.recordPerformance("transaction.submit", 250);

// Record error
analyticsManager.recordError("validation_error", {
  field: "amount",
  message: "Amount must be positive",
});
```

## Safe Dimensions

Only these dimensions are allowed in metrics:
- `event_type` - Type of event
- `feature` - Feature name
- `platform` - Platform (web, mobile, etc.)
- `network` - Network (mainnet, testnet, etc.)
- `timestamp` - Event timestamp
- `duration` - Operation duration
- `error_type` - Error classification

## Validation

The system automatically validates metrics before sending:

```typescript
const validation = analyticsManager.validateMetric(metric);
if (!validation.valid) {
  console.error("Invalid metric:", validation.issues);
}
```

## Retention Policy

- Aggregated metrics: 90 days
- Error logs: 30 days
- Performance data: 7 days
- User events: 90 days

## Testing

```bash
npm run test features/analytics
```

Tests verify:
- No sensitive data is logged
- Only safe dimensions are aggregated
- Metrics are properly validated
- Error context is sanitized
- Laplace samples follow the configured scale and are applied to bounded aggregate reports
- Reports do not contain event-level identifiers, dimensions, or precise timestamps
- Daily epsilon budgets stop additional report releases when exhausted

```