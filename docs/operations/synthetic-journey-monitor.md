# Operational Guide: Trellis Synthetic Journey Monitor

## Overview & Purpose

The **Trellis Synthetic Journey Monitor** exercises and verifies the platform's most critical, high-value end-to-end user workflow:
**Agent Discovery, Acquisition, and On-Chain Execution (`agent-acquisition-and-execution`)**.

Rather than relying purely on passive metric collection or isolated unit probes, the synthetic journey monitor continuously simulates a real actor traversing the complete Trellis application stack:
1. Validating wallet session hydration and native reserve balances.
2. Querying the marketplace catalog for agent parameters and metadata pointers.
3. Fetching and validating IPFS metadata manifests and cryptographic capability hashes.
4. Evaluating protocol safety guards (emergency pause status, configuration versioning, and abuse risk).
5. Running Soroban smart contract preflight simulations to calculate CPU instruction and fee budgets.
6. Broadcasting transactions through Stellar Horizon, awaiting confirmation, and minting canonical receipts.
7. Verifying post-execution ledger state invariants to prevent silent state drift.

Each run measures precise per-step latencies, checks adherence to strict SLA thresholds, andâ€”upon failure or latency degradationâ€”**accurately attributes dependency blame** to the specific subsystem responsible.

---

## The Critical Happy Path Workflow

The synthetic journey executes seven sequential stages:

```
[1. Wallet Session Check]
        â”‚ (Valid Ed25519 format, native reserve â‰¥ 1.0 XLM)
        â–¼
[2. Marketplace Catalog Lookup]
        â”‚ (Agent metadata, pricing, IPFS CID discovery)
        â–¼
[3. IPFS Metadata Retrieval]
        â”‚ (Gateway retrieval, manifest integrity, capabilities validation)
        â–¼
[4. Protocol Safety Guard]
        â”‚ (Emergency pause status, protocol config versioning, abuse policy)
        â–¼
[5. Soroban Preflight Simulation]
        â”‚ (Simulate contract execution, footprint analysis, CPU instruction estimation)
        â–¼
[6. Transaction Broadcast & Confirmation]
        â”‚ (Horizon submission, sequence verification, receipt minting)
        â–¼
[7. Post-Execution State Verification]
        â”‚ (Ledger invariant check, ownership verification, balance delta assertion)
```

If any step fails, the workflow immediately halts, records the exact error envelope, and evaluates the root-cause culprit.

---

## Latency SLA Targets & Degradation

Every step is assigned an SLA latency budget based on production target requirements:

| Step ID | Target Subsystem | SLA Threshold | Failure Trigger |
| :--- | :--- | :--- | :--- |
| `wallet_session_check` | `wallet-session` | **250 ms** | Disconnected, malformed address, balance < 1 XLM |
| `catalog_agent_lookup` | `marketplace-catalog` | **350 ms** | Agent not found, missing CID, catalog database error |
| `ipfs_metadata_fetch` | `ipfs-gateway` | **800 ms** | Gateway timeout (504/502), corrupt manifest |
| `protocol_guard_evaluation` | `protocol-guard` | **200 ms** | Emergency pause active, abuse block, version mismatch |
| `soroban_preflight_simulation`| `soroban-rpc` | **1200 ms** | CPU budget exceeded, contract trap, RPC 5xx |
| `transaction_submission` | `stellar-horizon` | **2500 ms** | Horizon 429, `txBAD_SEQ`, unconfirmed timeout |
| `post_execution_state_verification` | `ledger-state` | **300 ms** | State mismatch, ownership not updated, balance desync |
| **Total Journey Budget** | **End-to-End** | **5000 ms** | Journey duration > 5000 ms triggers `degraded` state |

### Health Status Definitions
- **`healthy`**: All 7 steps passed within their respective SLA latency thresholds.
- **`degraded`**: All steps succeeded, but one or more steps (or the aggregate duration) breached SLA thresholds.
- **`failed`**: One or more steps encountered a fatal error.

---

## Dependency Blame Attribution Taxonomy

When a failure or SLA breach occurs, the blame engine categorizes the culprit and recommends actionable remediation:

### 1. `wallet-session`
- **Root Cause**: Malformed public key format, locked/disconnected wallet extension, or insufficient native XLM balance.
- **Remediation**: Fund the account via testnet Friendbot, prompt wallet reconnect, or check local storage session keys.

### 2. `marketplace-catalog`
- **Root Cause**: Search index desynchronization, PostgreSQL/KV database connection pool exhaustion, or missing catalog records.
- **Remediation**: Check search index worker health, reseed marketplace fixtures, or inspect database query plans.

### 3. `ipfs-gateway`
- **Root Cause**: IPFS gateway timeout (HTTP 504), gateway overload (HTTP 502), or unpinned CID.
- **Remediation**: Failover to secondary gateway (e.g. Pinata, Cloudflare IPFS, Web3.Storage), verify CID pin status on IPFS cluster.

### 4. `protocol-guard`
- **Root Cause**: High-risk operation paused via governance emergency pause, request flagged by abuse detection, or outdated protocol config version.
- **Remediation**: Inspect emergency pause state on Governance dashboard, review abuse velocity scoring, or update frontend configuration schemas.

### 5. `soroban-rpc`
- **Root Cause**: Soroban RPC timeout, CPU instruction limit exceeded (`RESOURCE_LIMIT_EXCEEDED`), or contract trap.
- **Remediation**: Scale Soroban RPC validator nodes, optimize smart contract instruction footprint, or adjust transaction fee bids.

### 6. `stellar-horizon`
- **Root Cause**: Horizon rate limit (HTTP 429), account sequence number desync (`txBAD_SEQ`), or submission network timeout.
- **Remediation**: Refresh source account sequence from Horizon, implement exponential backoff with jitter, or failover to private Horizon endpoint.

### 7. `ledger-state`
- **Root Cause**: Event emission lag, delayed ledger entry indexing, or transaction rollback.
- **Remediation**: Inspect Core ingestion lag, review transaction confirmation logs, and audit contract state mutations.

### 8. `network`
- **Root Cause**: `ECONNREFUSED`, `ETIMEDOUT`, DNS resolution failure.
- **Remediation**: Check outbound gateway, VPC egress rules, and proxy configurations.

---

## Running the Monitor

### 1. Single Run (Human-Readable CLI)
```bash
npm run monitor:journey
```

### 2. Strict SLA Mode (Exit code 1 on degraded runs)
```bash
npm run monitor:journey -- --strict
```

### 3. Machine-Readable JSON Output
```bash
npm run monitor:journey -- --json
```

### 4. Multi-Iteration Canary / Load Run
```bash
# Run 10 iterations with a 250ms interval between runs
npm run monitor:journey -- --iterations 10 --interval 250
```

### 5. Testing Failure Scenarios Locally
```bash
# Test IPFS gateway outage
npm run monitor:journey -- --scenario ipfs_down

# Test Governance Emergency Pause
npm run monitor:journey -- --scenario emergency_paused

# Test Soroban RPC simulation timeout
npm run monitor:journey -- --scenario rpc_timeout

# Test Stellar Horizon rate limiting
npm run monitor:journey -- --scenario horizon_rate_limited
```

### Exit Codes
- `0`: All steps passed within SLA (healthy).
- `1`: Journey execution failed, or SLA degraded with `--strict`.
- `2`: Invalid CLI options or configuration error.

---

## Continuous & Scheduled Monitoring

The `SyntheticJourneyScheduler` class enables automated background polling:

```typescript
import { SyntheticJourneyScheduler } from '@/lib/journey-monitor';

const scheduler = new SyntheticJourneyScheduler({
  intervalMs: 60_000, // Run every 60 seconds
  maxHistory: 100,    // Keep last 100 runs in bounded memory
  onAlert: ({ previousStatus, currentStatus, result }) => {
    console.error(`Journey alert: transition from ${previousStatus} to ${currentStatus}`);
    // Dispatch to PagerDuty, Slack webhook, or lifecycleManager
  },
});

scheduler.start();
```

### Memory Safety & Bounded History
The scheduler caps memory usage by enforcing `maxHistory` (default: 100). Oldest results are evicted automatically using FIFO rotation, preventing memory growth in long-running node processes.

---

## Operational Edge Cases & Failure Playbook

### Edge Case 1: Horizon Rate Limiting (HTTP 429)
- **Symptom**: Step 6 fails with `Stellar Horizon HTTP 429 Too Many Requests`.
- **Action**: Synthetic journey client respects `Retry-After` headers if present. Ensure dedicated API keys are used for automated canary traffic to avoid competing with user traffic.

### Edge Case 2: Sequence Number Desync (`txBAD_SEQ`)
- **Symptom**: Step 6 fails with `txBAD_SEQ`.
- **Action**: Occurs when multiple synthetic workers or tests share the same source account. Dedicated per-worker keypairs should be provisioned for concurrent canary runners.

### Edge Case 3: Emergency Protocol Pause Triggered
- **Symptom**: Step 4 fails with `Operation 'mint_agent' is paused by governance emergency control`.
- **Action**: Check `#alerts-governance` and the Governance admin panel. Verify whether the pause was intentional. Do not attempt automated unpause without security review.

### Edge Case 4: IPFS Gateway Pinning Propagation Lag
- **Symptom**: Step 3 fails intermittently with 504 on newly minted agents.
- **Action**: Implement multi-gateway fallbacks (`https://ipfs.io`, `https://cloudflare-ipfs.com`, `https://gateway.pinata.cloud`) with racing logic.

---

## Rollback & Recovery Procedures

If synthetic monitoring detects persistent failures after a frontend deployment:

1. **Verify Blame Attribution**:
   - If blamed on `protocol-guard` or `soroban-rpc` due to contract changes, check recent contract deployments and schema migrations.
   - If blamed on `stellar-horizon` or `network`, check upstream infrastructure provider status pages.
2. **Rollback Release**:
   - Revert to previous release artifact tag or commit:
     ```bash
     git revert HEAD
     npm run build
     npm run monitor:journey -- --strict
     ```
3. **Verify Recovery**:
   - Run the synthetic journey in strict mode across 5 iterations:
     ```bash
     npm run monitor:journey -- --iterations 5 --interval 500 --strict
     ```
   - Confirm exit code `0` and 100% availability before marking the incident resolved.
