# Partial Failure Dashboard: Operational Guide

## Overview

The Partial Failure Dashboard provides operators with a comprehensive view of unresolved partial failures from async jobs, integrations, and user-visible operations. It enables filtering, inspection, safe retry, and identification of failures requiring user action.

## Architecture

### Data Flow

1. **Failure Recording**: Operations that fail partially record failures via `partialFailureTracker.recordFailure()`
2. **Dashboard Rendering**: Dashboard polls the tracker every 30 seconds for updates
3. **Filtering & Sorting**: Client-side filtering and sorting for responsive UI
4. **Action Execution**: Operators can retry, resolve, or mark failures for manual intervention
5. **Status Updates**: Actions update failure status and trigger dashboard refresh

### Components

- **PartialFailureTracker** (`lib/partial-failures.ts`): Core tracking logic
- **PartialFailureDashboard** (`features/partial-failure-dashboard/PartialFailureDashboard.tsx`): UI component
- **API Integration**: Future enhancement for remote persistence

## Failure Types

### Operation Types

- **transaction**: Financial transactions that failed mid-execution
- **sync**: Data synchronization operations with external systems
- **webhook**: Webhook delivery failures
- **import**: Bulk import operations
- **export**: Bulk export operations
- **background_job**: Scheduled background tasks

### Severity Levels

- **critical**: Immediate user impact, requires urgent attention
- **high**: Significant impact, should be addressed soon
- **medium**: Moderate impact, can be scheduled
- **low**: Minor impact, may be ignored

### Status Values

- **unresolved**: New failure, not yet addressed
- **retrying**: Currently in retry queue with scheduled retry
- **resolved**: Successfully resolved by operator or system
- **manual_intervention**: Requires human review/action

## Operational Edge Cases

### 1. Stale Failures

**Scenario**: Failures that have remained unresolved for an extended period (default: 7 days).

**Behavior**:
- Dashboard shows stale failures prominently
- Stale failures are highlighted in the report
- Operators can filter by age to identify stale items

**Monitoring**: Track stale failure count and age distribution.

**Recovery**:
- Review stale failures for resolution
- Determine if operation is still relevant
- Resolve or mark for manual intervention as appropriate

### 2. Retry Storm

**Scenario**: Large number of failures retrying simultaneously after an outage.

**Behavior**:
- Each failure has independent retry schedule with jitter
- Dashboard shows retrying status and next retry time
- Retry queue prevents simultaneous retries

**Monitoring**: Track retrying count and retry rate.

**Recovery**:
- Identify root cause of outage
- Pause retries if necessary (future enhancement)
- Address root cause before retries continue

### 3. Dead Letter Accumulation

**Scenario**: Failures reach terminal state and accumulate in dead letter queue.

**Behavior**:
- Failures that exhaust retries link to dead letter records
- Dashboard shows dead letter ID for terminal failures
- Operators can jump to dead letter queue for full history

**Monitoring**: Track dead-lettered failure count.

**Recovery**:
- Review dead letter records for patterns
- Identify systemic issues causing terminal failures
- Fix underlying issues to prevent accumulation

### 4. Manual Intervention Backlog

**Scenario**: Large number of failures marked for manual intervention.

**Behavior**:
- Dashboard shows manual intervention count in summary
- Manual intervention failures are prominently displayed
- Requires user action indicator is shown

**Monitoring**: Track manual intervention count and age.

**Recovery**:
- Prioritize by severity and age
- Escalate to appropriate teams
- Document resolution patterns for automation

### 5. Critical Failure Surge

**Scenario**: Sudden increase in critical failures.

**Behavior**:
- Critical failures are highlighted in red
- Dashboard shows critical count prominently
- Requires user action indicator is shown

**Monitoring**: Alert on critical failure rate spikes.

**Recovery**:
- Immediate investigation of root cause
- Temporarily pause affected operations if needed
- Communicate with users about impact

### 6. Resource Contention

**Scenario**: Failures related to specific resources (e.g., database, external API).

**Behavior**:
- Failures grouped by resource ID in internal state
- Can filter by resource to see all related failures
- Helps identify systemic resource issues

**Monitoring**: Track failures by resource for patterns.

**Recovery**:
- Identify failing resource
- Check resource health and capacity
- Scale or repair resource as needed

### 7. Non-Retryable Failures

**Scenario**: Failures that cannot be automatically retried (e.g., import, export).

**Behavior**:
- Retry button is hidden for non-retryable types
- Must be resolved manually or marked for intervention
- Dashboard shows operation type to identify these

**Monitoring**: Track non-retryable failure count.

**Recovery**:
- Review failure details
- Determine if operation can be safely retried manually
- Mark resolved or for manual intervention

### 8. Resolution Conflicts

**Scenario**: Multiple operators attempting to resolve the same failure.

**Behavior**:
- Current implementation is in-memory (no locking)
- Last resolution wins
- Future enhancement: add optimistic locking

**Monitoring**: Audit resolution actions by operator.

**Recovery**:
- Establish communication protocols for operators
- Use "manual intervention" status for contentious cases
- Document resolution decisions

### 9. Dashboard Performance Degradation

**Scenario**: Large number of failures causing slow dashboard rendering.

**Behavior**:
- Client-side filtering/sorting may become slow
- Polling every 30 seconds adds load
- No pagination or virtualization currently

**Monitoring**: Track dashboard load time and failure count.

**Recovery**:
- Reduce failure count by resolving old failures
- Implement pagination or virtualization (future)
- Increase polling interval if needed

### 10. Data Loss on Refresh

**Scenario**: Dashboard state lost on page refresh (current in-memory implementation).

**Behavior**:
- All failure data is in-memory
- Page refresh loses all unresolved failures
- No persistence layer currently

**Monitoring**: Track dashboard refresh frequency.

**Recovery**:
- Implement persistence layer (future enhancement)
- Until then, warn operators about data loss risk
- Use dead letter queue for critical failures

## Failure Modes

### Catastrophic Failures

#### Tracker Corruption
- **Detection**: Inconsistent state, crashes on operations
- **Impact**: All failure tracking becomes unreliable
- **MTTR**: Tracker reset and restart
- **Rollback**: Reset tracker and re-record failures from logs

#### Memory Exhaustion
- **Detection**: Dashboard becomes unresponsive, browser crashes
- **Impact**: Cannot view or manage failures
- **MTTR**: Browser restart, failure cleanup
- **Rollback**: Clear resolved failures, reduce retention

### Degraded Failures

#### Slow Dashboard Rendering
- **Detection**: Dashboard takes >5 seconds to load
- **Impact**: Operator productivity reduced
- **MTTR**: Failure cleanup or pagination implementation
- **Rollback**: Filter to show fewer failures

#### Inconsistent Retry Scheduling
- **Detection**: Retries not executing as expected
- **Impact**: Failures not resolving automatically
- **MTTR**: Retry policy adjustment
- **Rollback**: Manual retry of affected failures

## Rollback and Recovery Procedures

### Immediate Rollback

1. **Stop Operations**
   - Identify affected operation types
   - Pause new operations if necessary
   - Communicate with users about impact

2. **Assess State**
   - Review failure report for patterns
   - Check critical and stale failures
   - Identify root cause

3. **Stabilize System**
   - Resolve or address root cause
   - Clear backlog of retryable failures
   - Mark non-retryable failures appropriately

4. **Restore Operations**
   - Resume normal operations
   - Monitor for new failures
   - Adjust retry policies if needed

### Data Consistency

#### In-Memory Data Loss
- Current implementation uses in-memory storage
- Page refresh or restart loses all data
- Dead letter queue provides some persistence for terminal failures

#### Resolution Conflicts
- No locking mechanism currently
- Last resolution wins
- Establish operator communication protocols

### Monitoring and Alerting

#### Key Metrics

- **Total Failures**: Overall failure count
- **Critical Failures**: Count and rate of critical failures
- **Stale Failures**: Count and age of stale failures
- **Retryable Failures**: Count of failures in retry queue
- **Manual Intervention**: Count requiring human action
- **Retry Success Rate**: Percentage of retries that succeed
- **Resolution Time**: Time from failure to resolution

#### Alert Thresholds

- Critical failures > 10
- Stale failures > 50
- Manual intervention backlog > 20
- Retry success rate < 50%
- Resolution time P95 > 24 hours

## Security Considerations

### Access Control

- Dashboard should be restricted to operators/maintainers
- Implement authentication and authorization (future)
- Audit all resolution and retry actions

### Data Exposure

- Internal state may contain sensitive information
- Consider redaction for certain fields
- Log access to failure details

### Action Authorization

- Not all operators should be able to resolve critical failures
- Implement role-based permissions (future)
- Require confirmation for destructive actions

## Performance Optimization

### Dashboard Performance

- Implement pagination for large datasets
- Add virtual scrolling for failure list
- Debounce search input
- Cache filtering/sorting results

### Tracker Performance

- Use indexed data structures for lookups
- Implement batch operations for bulk actions
- Add persistence layer to reduce memory usage
- Consider database-backed storage

### Network Performance

- Implement server-side filtering (future)
- Use WebSocket for real-time updates (future)
- Compress large internal state payloads
- Implement incremental updates

## Testing Recommendations

### Unit Tests

- Filter logic for all filter types
- Sort logic for all sort fields
- Retry safety checks
- Resolution validation
- User action required logic

### Integration Tests

- End-to-end failure lifecycle
- Dashboard updates on tracker changes
- Action execution and state updates
- Large dataset handling

### Load Tests

- Dashboard with 1000+ failures
- Concurrent operator actions
- Rapid failure recording
- Polling under load

### Chaos Tests

- Tracker reset during operation
- Network failures during action execution
- Browser crash and recovery
- Concurrent resolution attempts

## Troubleshooting Guide

### Dashboard Shows No Failures

**Cause**: No failures recorded or tracker reset

**Resolution**:
1. Check if tracker was reset
2. Verify failure recording is working
3. Check browser console for errors
4. Refresh dashboard

### Retry Button Not Showing

**Cause**: Failure is not retryable or max retries exceeded

**Resolution**:
1. Check operation type (import/export are non-retryable)
2. Check retry count vs max retries
3. Review failure status
4. Use manual intervention if needed

### Failures Not Auto-Retrying

**Cause**: Retry policy configuration or classification issue

**Resolution**:
1. Check retry policy settings
2. Verify error classification
3. Check if failure is marked non-retryable
4. Manually trigger retry if appropriate

### Dashboard Loading Slowly

**Cause**: Too many failures or inefficient filtering

**Resolution**:
1. Clear resolved failures
2. Apply filters to reduce visible count
3. Increase polling interval
4. Consider pagination implementation

### Actions Not Persisting

**Cause**: In-memory implementation loses data on refresh

**Resolution**:
1. Implement persistence layer (future)
2. Use dead letter queue for critical failures
3. Document actions externally
4. Warn operators about data loss risk

## Integration Guide

### Adding New Operation Types

1. Add type to `OperationType` enum in `lib/partial-failures.ts`
2. Update retry policy if needed in `isRetryable()`
3. Add to dashboard filter options
4. Update tests to cover new type

### Custom Retry Policies

1. Call `partialFailureTracker.setRetryPolicy()` with custom settings
2. Adjust maxRetries, delays, and backoff multiplier
3. Test with representative failures
4. Monitor retry success rate

### Adding Custom Filters

1. Add filter state to `FilterState` type
2. Add UI control to dashboard
3. Implement filter logic in `filteredFailures` useMemo
4. Add tests for new filter

## Future Enhancements

### Planned Features

- Persistence layer (database storage)
- Server-side filtering and pagination
- Real-time updates via WebSocket
- Bulk actions (resolve multiple failures)
- Export failure data
- Failure trends and analytics
- Automated resolution suggestions
- Integration with alerting systems
- Role-based access control
- Audit logging

### Potential Improvements

- Virtual scrolling for large datasets
- Advanced search with regex
- Failure grouping and aggregation
- Time-based failure heatmaps
- Root cause analysis
- Predictive failure detection
- Automated escalation workflows
- Integration with incident management systems

## Migration Notes

### From Manual Tracking

**Breaking Changes**:
- Centralized failure tracking vs. scattered logs
- Standardized failure schema
- Dashboard-based vs. CLI-based management

**Migration Steps**:
1. Identify existing failure tracking mechanisms
2. Map to new failure types and severities
3. Update code to use `partialFailureTracker`
4. Train operators on new dashboard
5. Phase out old tracking systems

### Adding Persistence

**Future Enhancement**:
- Currently in-memory only
- Add database backing for production
- Implement migration from in-memory to DB
- Add backup and recovery procedures

## Best Practices

### For Operators

1. **Review Critical Failures First**: Prioritize by severity
2. **Address Stale Failures**: Don't let failures accumulate
3. **Document Resolutions**: Add notes for future reference
4. **Use Manual Intervention Wisely**: For cases requiring human judgment
5. **Monitor Trends**: Look for patterns in failures

### For Developers

1. **Record Failures Early**: Capture failure details at point of failure
2. **Include Context**: Add relevant internal state for debugging
3. **Set Appropriate Severity**: Use severity to guide operator attention
4. **Test Retry Logic**: Verify retry policies work as expected
5. **Monitor Dashboard Performance**: Ensure dashboard remains responsive

### For Site Reliability Engineers

1. **Set Up Monitoring**: Track key metrics and set alerts
2. **Review Regularly**: Check dashboard daily for issues
3. **Escalate Patterns**: Identify systemic issues early
4. **Document Incidents**: Learn from failures
5. **Continuously Improve**: Refine retry policies and automation
