# Permission-Aware Export Pipeline: Operational Guide

## Overview

The permission-aware export pipeline (`lib/export/streaming-export.ts`) provides a production-ready system for exporting data with built-in security, memory safety, and cancellation support.

## Architecture

### Three-Phase Flow

1. **Authorization Phase**
   - Validates caller identity via `requirePermission`
   - Checks `export_data` action against permission matrix
   - Determines resource scope and applicable conditions
   - Returns early on authorization failure

2. **Streaming Phase**
   - Fetches data in configurable batches (default: 1000 records)
   - Checks cancellation signal before each batch
   - Redacts fields based on caller's role
   - Writes to output stream with backpressure handling
   - Tracks redaction statistics

3. **Completion Phase**
   - Writes format-specific footer (JSON array close, etc.)
   - Returns metadata with statistics
   - Logs telemetry for monitoring

## Configuration

### Default Configuration

```typescript
{
  batchSize: 1000,              // Records per batch
  maxMemoryBytes: 100 * 1024 * 1024,  // 100MB soft limit
  batchTimeoutMs: 30000,        // 30 seconds per batch
  debug: false,                 // Debug telemetry
}
```

### Tuning Guidelines

- **Small datasets (< 10K records)**: Use default `batchSize: 1000`
- **Medium datasets (10K-100K records)**: Increase to `batchSize: 5000`
- **Large datasets (> 100K records)**: Use `batchSize: 10000` with monitoring
- **Memory-constrained environments**: Reduce `batchSize` to `500` or lower

## Operational Edge Cases

### 1. Client Disconnection

**Scenario**: Client aborts the request mid-export.

**Behavior**:
- AbortController signal propagates immediately
- Current batch completes processing
- No new batches are fetched
- Stream closes gracefully
- Metadata marks export as `cancelled: true`

**Monitoring**: Track `cancelled` flag in export metadata. High cancellation rates may indicate:
- Network instability
- Client timeout configuration too aggressive
- Overly large exports

**Recovery**: Client can retry the export with the same parameters.

### 2. Database Connection Failure

**Scenario**: Database becomes unavailable during export.

**Behavior**:
- Fetcher throws error
- Export pipeline catches error
- Metadata includes `error` field with error message
- Stream closes with error state
- Partial data may have been sent to client

**Monitoring**: Track `error` field in metadata. Common patterns:
- Connection timeouts: Check DB health
- Query timeouts: Increase `batchTimeoutMs` or optimize queries
- Deadlocks: Review DB isolation levels

**Recovery**:
- Check database health
- Verify query performance
- Retry export after issue resolution

### 3. Memory Pressure

**Scenario**: Server memory usage approaches limits during large export.

**Behavior**:
- Batch processing enforces bounded memory
- Each batch is fully processed before next fetch
- Stream backpressure prevents unbounded buffering
- If `maxMemoryBytes` is exceeded, consider reducing `batchSize`

**Monitoring**:
- Track memory usage during exports
- Monitor batch processing times
- Alert on memory thresholds

**Recovery**:
- Reduce `batchSize` in configuration
- Implement rate limiting for concurrent exports
- Add horizontal scaling for export endpoints

### 4. Permission Changes Mid-Export

**Scenario**: User's role changes while export is in progress.

**Behavior**:
- Export uses role determined at authorization time
- Changes during export do not affect in-flight export
- Subsequent exports use new role

**Monitoring**: Audit logs show role at export start time.

**Recovery**: None needed by design. Role is captured at authorization phase.

### 5. Cancellation During Batch Processing

**Scenario**: Client cancels while a batch is being redacted.

**Behavior**:
- Cancellation signal checked during record iteration
- Current record completes redaction
- Batch processing stops
- No partial batch data is sent
- Metadata marks export as `cancelled: true`

**Monitoring**: Track cancellation timing (before fetch vs. during processing).

**Recovery**: Client can retry export.

### 6. Empty Dataset

**Scenario**: Export request matches no records.

**Behavior**:
- Fetcher returns empty array
- Export completes immediately
- Metadata shows `recordCount: 0`
- Format-specific headers/footers still written

**Monitoring**: High rate of empty exports may indicate:
- Incorrect date ranges
- Data quality issues
- User confusion

**Recovery**: Review export parameters and data availability.

### 7. Forbidden Field Access Attempt

**Scenario**: Low-privilege user requests export with restricted fields.

**Behavior**:
- Authorization phase denies if role lacks `export_data` permission
- If authorized, fields are redacted based on role
- Redaction markers: `[REDACTED:LEVEL]`
- Metadata tracks `redactedCount` and `redactedFieldCount`

**Monitoring**:
- Track redaction rates by role
- Alert on suspicious patterns (e.g., high redaction rate for admin users)

**Recovery**: User may request role escalation if business need exists.

### 8. Format Errors

**Scenario**: Record contains data that cannot be serialized to requested format.

**Behavior**:
- Format error caught in batch processing
- Batch result includes `error` field
- Export stops
- Metadata includes error message

**Monitoring**: Track format errors by export type and format.

**Recovery**:
- Review data quality
- Add pre-export validation
- Fix serialization logic for edge cases

### 9. Timeout During Batch Processing

**Scenario**: Single batch exceeds `batchTimeoutMs`.

**Behavior**:
- Timeout triggers error
- Export stops
- Metadata includes timeout error
- Partial data may have been sent

**Monitoring**:
- Track batch processing times
- Alert on timeouts
- Identify slow queries or complex redactions

**Recovery**:
- Increase `batchTimeoutMs` if timeouts are due to legitimate large batches
- Optimize slow queries
- Reduce `batchSize` to avoid timeouts

### 10. Concurrent Export Overload

**Scenario**: Multiple large exports run simultaneously.

**Behavior**:
- Each export uses its own batch processing
- Memory usage scales with concurrent exports
- No built-in rate limiting in pipeline

**Monitoring**:
- Track concurrent export count
- Monitor aggregate memory usage
- Alert on resource exhaustion

**Recovery**:
- Implement rate limiting at API gateway
- Add queue system for large exports
- Scale horizontally

## Failure Modes

### Catastrophic Failures

#### Database Outage
- **Detection**: Fetcher throws connection error
- **Impact**: All in-flight exports fail
- **MTTR**: Depends on DB recovery
- **Rollback**: Client retries after DB recovery

#### Application Crash
- **Detection**: Export process terminates
- **Impact**: In-flight exports fail mid-stream
- **MTTR**: Application restart
- **Rollback**: Client retries after restart

### Degraded Failures

#### Slow Query Performance
- **Detection**: Batch timeouts
- **Impact**: Exports complete slowly or timeout
- **MTTR**: Query optimization
- **Rollback**: Reduce `batchSize` or increase timeout

#### Memory Pressure
- **Detection**: High memory usage, OOM errors
- **Impact**: Exports may fail or crash
- **MTTR**: Memory release or scaling
- **Rollback**: Reduce concurrency or batch size

## Rollback and Recovery Procedures

### Immediate Rollback

1. **Stop in-flight exports**
   - Cancel via AbortController if client still connected
   - Kill process if application crashed

2. **Assess state**
   - Check export metadata for `cancelled` and `error` fields
   - Review logs for error details
   - Identify root cause (DB, network, permissions, etc.)

3. **Fix root cause**
   - Restore database connectivity
   - Fix network issues
   - Resolve permission conflicts
   - Optimize slow queries

4. **Retry export**
   - Client resubmits export request
   - Use same parameters for idempotency
   - Monitor for success

### Data Consistency

#### Partial Exports
- If export was cancelled mid-stream, client has partial data
- Client should discard partial export and retry
- No data corruption occurs due to streaming nature

#### Redaction Inconsistency
- All records in a batch use same role (captured at authorization)
- Redaction is deterministic per role
- No partial redaction within a record

### Monitoring and Alerting

#### Key Metrics

- **Export success rate**: `(successful_exports / total_exports) * 100`
- **Export cancellation rate**: `(cancelled_exports / total_exports) * 100`
- **Average export duration**: By export type and record count
- **Redaction rate**: `(redacted_fields / total_fields) * 100`
- **Batch processing time**: P50, P95, P99
- **Memory usage during export**: Peak and average

#### Alert Thresholds

- Export success rate < 95%
- Export cancellation rate > 10%
- Batch processing time P99 > 30s
- Memory usage > 80% of limit
- Database connection failures > 5%

## Security Considerations

### Permission Enforcement

- Export requires `export_data` action
- Resource scope enforced (own/project/global)
- Conditions checked (owner_only, rate_limited, etc.)
- Role captured at authorization, not during streaming

### Field-Level Redaction

- Fields tagged with required permission levels
- Redaction applied before serialization
- Redaction markers clearly indicate what was hidden
- Redaction statistics tracked in metadata

### Data Leakage Prevention

- No raw PII in error messages
- Forbidden fields never sent to unauthorized roles
- CSV format injection neutralized
- Audit trail of all exports with metadata

## Performance Optimization

### Query Optimization

- Use indexed columns for date range filters
- Implement cursor-based pagination for large datasets
- Consider materialized views for complex aggregations
- Cache frequently accessed permission metadata

### Batch Size Tuning

- Profile with realistic data volumes
- Balance between memory usage and throughput
- Monitor GC pressure during exports
- Consider adaptive batch sizing based on record size

### Streaming Efficiency

- Use backpressure-aware stream writers
- Avoid buffering entire response in memory
- Implement chunk compression for large payloads
- Consider HTTP/2 for multiplexing

## Testing Recommendations

### Unit Tests

- Permission enforcement logic
- Field redaction by role
- Batch processing with various sizes
- Cancellation signal propagation
- Error handling paths

### Integration Tests

- End-to-end export with real database
- Permission matrix integration
- Streaming response verification
- Concurrent export handling

### Load Tests

- Large dataset exports (100K+ records)
- Concurrent export scenarios
- Memory usage under load
- Cancellation under load

### Chaos Tests

- Database disconnection mid-export
- Network timeout during export
- Application crash during export
- Permission changes during export

## Troubleshooting Guide

### Export Returns 403 Forbidden

**Cause**: User lacks `export_data` permission

**Resolution**:
1. Check user's role in permission matrix
2. Verify resource scope matches request
3. Review permission conditions (owner_only, etc.)
4. Escalate role if business need exists

### Export Returns 422 Validation Error

**Cause**: Invalid request parameters

**Resolution**:
1. Check wallet address format (56 characters)
2. Verify export type is valid
3. Ensure date range is valid ISO 8601
4. Confirm format is json or csv

### Export Hangs Indefinitely

**Cause**: Slow query or deadlock

**Resolution**:
1. Check database query performance
2. Review database locks
3. Increase `batchTimeoutMs` if needed
4. Optimize query with proper indexes

### Export Completes with Empty Data

**Cause**: No records match criteria

**Resolution**:
1. Verify date range is correct
2. Check data exists in database
3. Confirm wallet has associated records
4. Review filter conditions

### Export Shows High Redaction Count

**Cause**: User role insufficient for field access

**Resolution**:
1. Review field permission requirements
2. Check user's role
3. Escalate role if business need exists
4. Verify data sensitivity classification

## Migration Notes

### From Legacy Export (v1.0)

**Breaking Changes**:
- Requires `export_data` permission (previously unenforced)
- Field-level redaction (previously unrestricted)
- Streaming response (previously buffered)
- Cancellation support (new)

**Migration Steps**:
1. Update permission matrix to include `export_data` for existing users
2. Define field permissions for each export type
3. Update clients to handle streaming responses
4. Add cancellation support to clients
5. Monitor redaction rates and adjust permissions

**Backward Compatibility**:
- Legacy export endpoint can be maintained alongside new version
- Gradual migration by routing based on client version
- Feature flag to enable new pipeline

## Future Enhancements

### Planned Features

- Export job queue for async processing
- Progress tracking for long-running exports
- Export history and audit UI
- Differential exports (since last export)
- Compression options (gzip, brotli)
- Export templates with saved filters
- Webhook notifications on export completion

### Potential Improvements

- Adaptive batch sizing based on record size
- Predictive memory usage estimation
- Export deduplication
- Cross-dataset exports
- Real-time export preview
- Export scheduling
