# Incident Triage and Emergency Rollback Runbook

## Overview

This runbook provides a structured approach for diagnosing and resolving incidents in Trellis Frontend. It covers incident categories, triage steps, mitigation strategies, and emergency rollback procedures.

## Incident Categories

### 1. Critical User-Facing Outages (P1)
- **Symptoms**: Users cannot access platform, complete transactions, or connect wallets
- **Response Time**: < 15 minutes
- **Escalation**: All hands on deck

### 2. Data Integrity Issues (P2)
- **Symptoms**: Balances incorrect, transaction records mismatched, reconciliation errors
- **Response Time**: < 1 hour
- **Escalation**: Data team + engineering

### 3. Security/Privacy Breaches (P1 or P2)
- **Symptoms**: Unauthorized data access, credential exposure, signature validation failures
- **Response Time**: < 15 minutes for P1, < 1 hour for P2
- **Escalation**: Security team + incident commander

### 4. Performance Degradation (P3)
- **Symptoms**: API response times exceed thresholds, UI lag, search timeouts
- **Response Time**: < 4 hours
- **Escalation**: Infrastructure team

## Triage Workflow

### Step 1: Assess Impact Scope
```bash
# Check operational health dashboard
curl -s https://dashboard.trellis.io/api/health | jq '.incidents'

# Review error logs for patterns
grep -i "error\|critical\|exception" /var/log/trellis-frontend.log | tail -100

# Check Algolia search index status
curl -X GET "https://[ALGOLIA_APP_ID].algolia.net/1/indexes/claims/settings" \
  -H "X-Algolia-API-Key: [READ_API_KEY]"

# Verify blockchain connectivity
npm run test:stellar-health
```

### Step 2: Identify Root Cause Category
1. **Frontend issue**: Browser console errors, failed API calls, state corruption
2. **Backend issue**: API errors, database issues, service unavailability
3. **Infrastructure issue**: Network, DNS, CDN, load balancer failures
4. **Blockchain issue**: Stellar network outage, RPC endpoint failures

### Step 3: Gather Diagnostics
```bash
# Enable verbose logging
export DEBUG=trellis:* TRELLIS_LOG_LEVEL=debug

# Check feature flags status
npm run dev -- --inspect

# Export affected records for analysis
curl -s "https://api.trellis.io/v1/records?filter=affected" \
  -H "Authorization: Bearer [ADMIN_TOKEN]"
```

## Mitigation Strategies

### A. Feature Rollback (Low Risk)

#### For non-critical features:
1. **Disable via feature flag** (no redeployment needed)
   ```bash
   # Set in deployment environment
   TRELLIS_FEATURE_[FEATURE_NAME]=false
   
   # Changes take effect on app restart (< 5 minutes)
   # No data loss or inconsistency
   ```

2. **Verify rollback success**
   ```bash
   npm run test:feature-flag-[FEATURE_NAME]
   curl -s https://api.trellis.io/v1/status | jq '.features'
   ```

#### For critical features (requires code changes):
1. Create a temporary branch from last stable version
2. Deploy to staging for validation
3. Run full regression test suite (20-30 minutes)
4. Deploy to production with canary (5% traffic initially)

### B. Data Reconciliation

#### Identify affected records:
```bash
# Export all records changed in last N minutes
curl -X POST "https://api.trellis.io/v1/admin/export" \
  -H "Authorization: Bearer [ADMIN_TOKEN]" \
  -d '{"since": "'$(date -d '30 minutes ago' -I)'"}'

# Check for inconsistent signatures/hashes
npm run validate:canonicalization --affected-after "30min"
```

#### Repair strategies:
1. **Signature validation failure**
   ```bash
   npm run repair:signatures --batch-size 1000 --dry-run
   # Review output, then run without --dry-run
   ```

2. **Permission index stale entries**
   ```bash
   npm run repair:search-index --rebuild-permissions
   # Verifies all indexed records respect current visibility
   ```

3. **Schema version mismatch**
   ```bash
   npm run migrate:incompatible-records --target-version "v2"
   # Transforms legacy records to current schema
   ```

### C. Emergency Rollback to Previous Release

#### Full application rollback (last resort):
```bash
# 1. Identify last stable version
git log --oneline | grep "release" | head -5

# 2. Verify release tag exists and is tested
git tag -l "v*" | sort -V | tail -5

# 3. Deploy previous version
git checkout v[PREVIOUS_VERSION]
npm install --production
npm run build
npm run start

# 4. Verify health checks pass
npm run test:health-checks

# 5. Communicate status to users
curl -X POST "https://api.trellis.io/v1/admin/status" \
  -d '{"status": "recovering", "message": "Service being restored"}'
```

## Incident Decision Tree

```
Incident Detected
│
├─ User can connect wallet?
│  └─ No → Check Stellar network + Freighter integration
│         → Possible action: Disable wallet features, show fallback UI
│
├─ Balances showing correctly?
│  └─ No → Run signature verification + reconciliation
│         → Possible action: Reload balances, repair records
│
├─ Search/indexing working?
│  └─ No → Check Algolia status + permission filters
│         → Possible action: Repair index, disable search temporarily
│
├─ API responding within SLA?
│  └─ No → Check backend health + database connectivity
│         → Possible action: Enable caching, disable real-time sync
│
└─ Still unresolved?
   └─ Execute emergency rollback procedure (see above)
```

## Validation Commands

### Before any mitigation:
```bash
# Run full health check
npm run test:health-checks

# Validate no secrets exposed
npm run audit:secrets

# Check data integrity
npm run validate:canonicalization
npm run validate:permissions
npm run validate:schema-versions
```

### After any mitigation:
```bash
# Run regression tests
npm run test:critical-flows

# Verify search index consistency
npm run validate:search-index

# Confirm no data loss
npm run audit:record-counts

# Check user-facing metrics
curl -s https://api.trellis.io/v1/metrics/last-5min
```

## Communication Checklist

- [ ] Post initial status update within 5 minutes
- [ ] Identify root cause (within 15 minutes for P1)
- [ ] Provide estimated recovery time
- [ ] Update status every 15 minutes during incident
- [ ] Post incident summary when resolved
- [ ] Schedule postmortem within 24 hours

## Deployment and Rollback Guardrails

### Pre-deployment:
- [ ] All tests passing in CI/CD
- [ ] No breaking schema changes without version metadata
- [ ] Feature flags configured for new risky features
- [ ] Monitoring alerts configured for new features

### Post-deployment:
- [ ] Monitor error rates for 30 minutes
- [ ] Watch for increases in signature validation failures
- [ ] Verify search index remains consistent
- [ ] Check API latency remains within SLA

## Secrets and Access

- **Admin API tokens**: Stored in vault, rotated every 90 days
- **Stellar testnet credentials**: Used only in development/staging
- **Algolia API keys**: Read key used in frontend, write key in backend only
- **IPFS credentials**: nft.storage key restricted to upload only

**Never include secrets in incident reports or runbook examples.**

## Postmortem Template

After resolution, complete within 24 hours:

```markdown
## Incident Summary
- **Time detected**: [timestamp]
- **Duration**: [how long until resolved]
- **Severity**: P[1-4]
- **Root cause**: [concise description]

## Impact
- **Users affected**: [estimate or count]
- **Services affected**: [list]
- **Data affected**: [list or "none"]

## Timeline
- [Time]: Detected by [mechanism]
- [Time]: Root cause identified
- [Time]: Mitigation deployed
- [Time]: Verified resolved

## Resolution
- **Action taken**: [description]
- **How it was verified**: [commands run]

## Prevention
- **Follow-up tasks**: [list of improvements]
- **Owner**: [assigned to]
```

## Related Documentation

- **Incident Drill Runbook**: See `docs/incident-drill-runbook.md` for executable verification checks (`npm run drill:verify`)
- **Feature Flags**: See `docs/operational-rollout.md` for feature flag configuration
- **Operational Health**: Dashboard at `/dashboard/operations` for real-time metrics
- **Error Handling**: See `docs/client-error-handling.md` for taxonomy and recovery
- **Idempotency**: See `docs/idempotency.md` for safe retry strategies
- **API Contracts**: See `docs/api-contracts.md` for versioning and compatibility
