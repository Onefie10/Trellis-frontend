# Partial Failure Dashboard

A comprehensive dashboard for monitoring and managing unresolved partial failures from async jobs, integrations, and user-visible operations.

## Features

- **Filtering**: Filter failures by status, severity, operation type, age, and search term
- **Sorting**: Sort by creation date, update date, severity, or retry count
- **Inspection**: View detailed failure information including internal state
- **Safe Retry**: Retry failures with built-in safety checks
- **Resolution**: Mark failures as resolved or for manual intervention
- **User Action Indicators**: Visual indicators for failures requiring human attention
- **Real-time Updates**: Auto-refreshes every 30 seconds

## Quick Start

```tsx
import { PartialFailureDashboard } from '@/features/partial-failure-dashboard/PartialFailureDashboard';

export default function MyPage() {
  return <PartialFailureDashboard />;
}
```

## Recording Failures

```typescript
import { recordFailure } from '@/lib/partial-failures';

// Record a failure
const failure = recordFailure(
  'transaction',           // operation type
  'txn-abc123',           // operation ID
  { resourceId: 'res-1' }, // internal state
  'Network timeout',      // error message
  'ext-ref-456',          // external reference ID (optional)
  'high'                  // severity (optional, defaults to 'medium')
);
```

## Failure Types

### Operation Types

- `transaction`: Financial transactions
- `sync`: Data synchronization
- `webhook`: Webhook deliveries
- `import`: Bulk imports
- `export`: Bulk exports
- `background_job`: Scheduled tasks

### Severity Levels

- `critical`: Immediate user impact
- `high`: Significant impact
- `medium`: Moderate impact
- `low`: Minor impact

### Status Values

- `unresolved`: New failure
- `retrying`: In retry queue
- `resolved`: Successfully resolved
- `manual_intervention`: Requires human review

## Dashboard Features

### Filtering

The dashboard supports filtering by:
- **Status**: unresolved, retrying, resolved, manual_intervention
- **Severity**: critical, high, medium, low
- **Operation Type**: transaction, sync, webhook, import, export, background_job
- **Age**: < 1 hour, < 24 hours, < 7 days, < 30 days
- **Search**: Search by operation ID, error message, or resource ID

### Sorting

Sort failures by:
- Creation date (newest/oldest first)
- Update date (newest/oldest first)
- Severity (critical to low or low to critical)
- Retry count (highest/lowest first)

### Actions

Available actions per failure:
- **Inspect**: View detailed failure information
- **Retry**: Queue for automatic retry (if retryable)
- **Mark Resolved**: Mark as successfully resolved
- **Manual Intervention**: Mark for human review
- **Ignore**: Ignore low-severity failures

### User Action Required

Failures show a "Requires user action" indicator when:
- Status is `manual_intervention`
- Severity is `critical`
- Max retries have been exhausted

## API Reference

### `recordFailure()`

Records a new partial failure.

```typescript
recordFailure(
  operationType: OperationType,
  operationId: string,
  internalState: Record<string, unknown>,
  errorMessage: string,
  externalRefId?: string,
  severity?: FailureSeverity
): PartialFailure
```

### `retryFailure()`

Retries a failure with safety checks.

```typescript
retryFailure(failureId: string): boolean
```

### `markFailureResolved()`

Marks a failure as resolved.

```typescript
markFailureResolved(failureId: string, notes?: string): boolean
```

### `markFailureManualIntervention()`

Marks a failure for manual intervention.

```typescript
markFailureManualIntervention(failureId: string, notes?: string): boolean
```

### `ignoreFailure()`

Ignores a low-severity failure.

```typescript
ignoreFailure(failureId: string, reason?: string): boolean
```

### `getFailureReport()`

Generates a comprehensive failure report.

```typescript
getFailureReport(): FailureReport
```

## Configuration

### Retry Policy

Configure retry behavior:

```typescript
import { partialFailureTracker } from '@/lib/partial-failures';

partialFailureTracker.setRetryPolicy({
  maxRetries: 5,
  initialDelayMs: 60000,      // 1 minute
  maxDelayMs: 86400000,       // 24 hours
  backoffMultiplier: 2,
  jitter: 'full',
});
```

### Stale Threshold

Configure when failures are considered stale:

```typescript
partialFailureTracker.setStaleThreshold(7 * 24 * 60 * 60 * 1000); // 7 days
```

## Testing

Run the test suite:

```bash
npm test -- features/partial-failure-dashboard/__tests__/PartialFailureDashboard.test.tsx
```

Test coverage includes:
- Rendering and display
- Filtering by all criteria
- Sorting by all fields
- Inspection of failure details
- Retry functionality
- Resolution and manual intervention
- User action required indicators
- Large dataset handling
- Message banners
- Accessibility

## Security

- **Access Control**: Dashboard should be restricted to operators/maintainers
- **Audit Logging**: All resolution and retry actions should be logged
- **Data Exposure**: Internal state may contain sensitive information

## Performance

- **Polling**: Dashboard refreshes every 30 seconds
- **Client-Side Filtering**: All filtering is done client-side for responsiveness
- **In-Memory Storage**: Current implementation uses in-memory storage
- **Future Enhancements**: Pagination, virtual scrolling, server-side filtering

## Troubleshooting

### Dashboard Shows No Failures

- Check if tracker was reset
- Verify failure recording is working
- Check browser console for errors
- Refresh dashboard

### Retry Button Not Showing

- Check operation type (import/export are non-retryable)
- Check retry count vs max retries
- Review failure status
- Use manual intervention if needed

### Dashboard Loading Slowly

- Clear resolved failures
- Apply filters to reduce visible count
- Increase polling interval
- Consider pagination implementation

## Integration

See [OPERATIONAL_GUIDE.md](./OPERATIONAL_GUIDE.md) for detailed operational documentation including:
- Edge cases and failure modes
- Rollback and recovery procedures
- Monitoring and alerting
- Performance optimization
- Integration guide

## Future Enhancements

- Persistence layer (database storage)
- Server-side filtering and pagination
- Real-time updates via WebSocket
- Bulk actions
- Export failure data
- Failure trends and analytics
- Role-based access control
- Audit logging

## License

Part of the Trellis Frontend project.
