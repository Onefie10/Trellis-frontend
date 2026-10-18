# Operational Guide: Developer Diagnostics & Doctor Command

## Overview & Purpose

The **Trellis Developer Diagnostics Command** (`npm run diagnostics` / `npm run doctor`) provides a single, non-mutating health check command that validates local contributor setup and external service assumptions across the Trellis Frontend stack:

1. **Developer Tooling & Runtime**: Verifies Node.js runtime (`>= 20.0.0`) and Git repository state.
2. **Configuration & Environment**: Validates `.env.example` presence, .env.local` variable synchronization, and strict [`AppConfig`](../lib/config/env.ts) security rules (HTTPS enforcement outside local development, Stellar network alignment, and webhook/permission secret hygiene) without leaking secret values.
3. **Project Dependencies & Setup**: Verifies `package.json`, `tsconfig.json`, `node_modules` installation, and core package manifests (`next`, `react`, `zod`, `@stellar/stellar-sdk`, `@stellar/freighter-api`).
4. **Service Connectivity & External Assumptions**: Probes Stellar Testnet Horizon (`https://horizon-testnet.stellar.org`), Stellar Soroban RPC (`https://soroban-testnet.stellar.org`), and Public IPFS gateway (`https://ipfs.io`) with bounded timeouts.
5. **Seed Data & Fixture Integrity**: Runs deterministic, read-only domain invariant validation against [`scripts/fixtures/recovery-baseline.json`](../scripts/fixtures/recovery-baseline.json), invariant monitor fixtures (`healthy-dataset.json` and `corrupted-dataset.json`), and `lib/db/mock-db.ts`.
6. **System Requirements**: Checks available system memory (`>= 4 GB` virtual memory) and free disk capacity (`>= 1 GB`).
7. **Local Ports**: Probes local ports (`3000`, `8080`) for `EADDRINUSE` conflicts and identifies owning processes.
8. **Common Failure Fixes & Self-Healing (--fix)**: Surfaces deterministic remediation and rollback commands for common contributor issues, and optionally initializes missing `.env.local` files or clears stale `.next` caches.

---

## Command Usage

```bash
# Run full diagnostics (human-readable report)
npm run diagnostics

# Alias command
npm run doctor

# Skip external network/RPC reachability checks (offline or air-gapped environments)
npm run diagnostics -- --skip-network

# Output structured machine-readable JSON for CI or automated tooling
npm run diagnostics -- --json

# Treat warnings as failures (exit code 1 on any warning or failure)
npm run diagnostics -- --strict

# Automatically apply safe, idempotent fixes (e.g., copy .env.example -> .env.local)
npm run diagnostics -- --fix

# Display the full catalog of common failure modes, fixes, and rollback commands
npm run diagnostics -- --show-fixes
```

---

## Operational Edge Cases & Failure Modes

| Code | Failure Mode / Symptom | Root Cause | Diagnostic Status | Remediation Command |
| :--- | :--- | :--- | :--- | :--- |
| `ENV_MISSING_LOCAL` | No `.env.local` or `.env` file detected | Fresh repository clone without environment initialization | `WARN` (`FAIL` in `--strict`) | `cp .env.example .env.local` or `npm run diagnostics -- --fix` |
| `ENV_SCHEMA_INVALID` | `AppConfig Schema & Security Rules` fails | Staging/production mode configured with `http://`, `localhost`, or `testnet`, or placeholder/short `WEBHOOK_SECRET` (`< 32` chars) | `FAIL` | Align `.env.local` with `.env.example` or generate a 32+ char secret via `openssl rand -base64 48` |
| `DEPS_MISSING_MODULES` | `node_modules` missing or missing critical packages | Dependencies not installed or interrupted `npm install` | `FAIL` / `WARN` | `npm install` |
| `SEED_DATA_CORRUPTED` | `Seed Data & Baseline Invariants` fails | Local edits to `scripts/fixtures/recovery-baseline.json` violated primary key uniqueness, Stellar address format, or financial rules | `FAIL` | `git checkout -- scripts/fixtures/recovery-baseline.json` |
| `NETWORK_RPC_UNREACHABLE` | Stellar Horizon, Soroban RPC, or IPFS gateway unreachable | Offline workspace, corporate proxy/firewall, DNS failure, or upstream HTTP 429/5xx | `WARN` (`FAIL` in `--strict`) | Use `npm run diagnostics -- --skip-network` for offline work; built-in mocks handle fallback |
| `PORT_CONFLICT | Port `3000` or `8080` currently in use | Orphaned Next.js dev server, Docker container, or background service occupying the port | `FAIL`| `npx kill-port 3000 8080` or stop the reported PID |
| `NEXT_CACHE_CORRUPTED` | Stale `.next` build artifacts causing webpack/HMR failures | Branch switching or interrupted `next build` | Manual / `--fix` | `rm -rf .next` |

### Security & Privacy Edge Cases
- **Zero Secret Leakage**: When `WEBHOOK_SECRET` or `PERMISSION_TOKEN_SECRET`fails validation (e.g., fewer than 32 characters or matching placeholder patterns like `change_me`), diagnostics report the violated policy name without ever echoing the secret value to `stdout`, `stderr`, or JSON output.
- **Offline Development Mode**: External network probes default to `WARN` rather than `FAIL` (unless `--strict` is passed) so contributors working offline or on restricted networks can still validate local code, seed data, and configuration.

---

## Rollback & Recovery Steps

If an automated fix (`--fix`) or manual configuration change introduces unexpected behavior, follow these deterministic recovery steps:

### 1. Rollback Environment Configuration
If `.env.local` was auto-generated or modified with incompatible endpoints:
```bash
# Remove local environment override completely
rm -f .env.local

# Or reset to the canonical repository template
cp .env.example .env.local
```

### 2. Rollback Seed Data & Test Fixtures
If local seed data or invariant test fixtures (`scripts/fixtures/recovery-baseline.json` or `tests/fixtures/`) fail invariant checks:
```bash
# Restore canonical seed data and fixtures from Git HEAD
git checkout HEAD -- scripts/fixtures/recovery-baseline.json tests/fixtures/

# Verify restoration
npm run validate:invariants
npm run diagnostics -- --skip-network
```

### 3. Rollback Corrupted Dependency Tree or Build Cache
If dependency upgrades or build caches cause module resolution failures:
```bash
# Purge build cache and node_modules, then reinstall cleanly
rm -rf .next node_modules
npm install
```

---

## Compatibility & Public Contracts

- **Non-Mutating by Default**: Running `npm run diagnostics` without `--fix` performs strictly read-only filesystem, socket, and HTTP `GET` checks.
- **Backward-Compatible JSON Schema**: The `--json` output preserves `timestamp`, `isSuccess`, `summary` (`total`, `passed`, `warnings`, `failures`), and `groups`, while extending the payload with `appliedFixes` and `commonFailureFixes`.

---

## Deterministic Chaos Test Suite

The chaos test suite validates interrupted user and background workflows without relying on wall-clock timing. It is executed via `npm run test:chaos` and is suitable for CI because all scheduling is driven by a virtual clock and a deterministic pseudo-random generator with a fixed seed.

### What the suite covers

- **Network failures**: injects `fetch` rejections, HTTP 5xx responses, HTTP 429 rate limits, and malformed JSON payloads at deterministic call indices.
- **Restarts**: simulates browser reloads and worker restarts mid-workflow to verify persisted state is reconciled correctly.
- **Stale reads**: serves an older snapshot after a newer write to confirm cache invalidation and version guards drop the stale response.
- **Retries**: verifies exponential backoff bounds, jutter determinism, max attempts, and idempotent replay of mutations.
- **Multi-actor concurrency**: drives multiple actors (wallet sessions, dashboard tabs, and background workers) against the same race-prone mutation to verify optimistic concurrency guards.
- **Duplicate submissions**: replays identical mutation payloads (same idempotency key) to confirm exactly-once application.
- **Stale versions**: submits a mutation against an older record version to confirm conflict detection and rejection with a deterministic error code.
- **Retry storms**: simulates many concurrent retries of the same mutation to confirm backoff caps, idempotency, and no duplicate writes.

### How determinism is achieved

-  All timers go through a virtual clock helper; tests advance the clock explicitly instead of waiting on real time.
-  All randomness (backoff jutter, failure injection order, actor interleaving) uses a seeded PRNG so a given seed reproduces the exact same sequence.
-  Network calls are routed through an in-memory transport that serves scripted responses; no sockets are opened during the suite.
-  Tests assert on observable outcomes (state transitions, error codes, retry counts) rather than elapsed time.

### Running the suite

```bash
# Full deterministic chaos suite
npm run test:chaos

# Reproduce a specific seed from a CI failure
npm run test:chaos -- --seed=<number>

# Run only the network-failure scenarios
npm run test:chaos -- --scenario=network-failure

# Run only the multi-actor concurrency scenarios
npm run test:chaos -- --scenario=multi-actor
```

### Operational edge cases for the chaos suite

| Scenario | Injected fault | Expected behavior | Recovery step |
| :--- | :--- | :--- | :--- |
| `network-failure` | `fetch` rejects with `ECONNRESET`/`ETIMEDOUT`| Workflow surfaces a retryable error and retries with bounded backoff | Reissue the workflow once the network is restored; no data is corrupted |
| `rate-limited` | HTTP 429 with `Retry-After` | Retry honors the backoff cap and eventually surfaces a non-fatal warning | Wait for the window to clear or switch to an alternate endpoint via .env.local |
| `restart-mid-workflow` | Worker is torn down and restarted between attempts | Persisted state is reconciled and no duplicate mutations are applied | Restart the worker; the checkpoint log resumes from the last committed attempt |
| `stale-read` | Server returns an older snapshot after a newer write | Version guard detects the stale payload and the cache is invalidated | Refetch after invalidation; the newest committed version wins |
| `retry-exhausted` | All retry attempts fail with transient errors | Workflow fails closed with a deterministic error code and no partial writes | Reissue manually after resolving the upstream fault; idempotent replay is safe |
| `multi-actor` | Three actors concurrently mutate the same record | Exactly one mutation commits; the others receive a deterministic conflict and refresh state | Retry the conflicted actor against the newest version; no lost writes |
| `duplicate-submit` | Same idempotency key submitted twice | The second submission returns the cached result without a second write | No recovery needed; the response is safe to replay |
| `stale-version` | Mutation submitted against an outdated version | Mutation is rejected with a version-conflict error and no partial write | Refresh the record and resubmit against the latest version |
| `retry-storm` | Many concurrent retries of the same mutation | Backoff caps are honored and idempotency prevents duplicate writes | No recovery needed; results are idempotent and safe to replay |

### Rollback for chaos-suite failures

If a chaos scenario fails in CI and you need to restore a clean state:

```bash
# Reset any chaos artifacts and rerun with the reported seed
npm run test:chaos -- --seed=<number>

# Confirm the baseline invariants are still valid
npm run validate:invariants

```

The chaos suite is purely in-memory and does not mutate repository files, databases, or network resources, so no data rollback is required beyond restarting the suite.
