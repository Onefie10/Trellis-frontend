/**
 * Dependency blame attribution engine for synthetic journey monitoring.
 *
 * Pinpoints the exact faulty subsystem (Wallet, Catalog, IPFS, Protocol Guard,
 * Soroban RPC, Stellar Horizon, Receipt Service, or Ledger State) when an end-to-end
 * user journey fails or experiences latency degradation.
 */

import type { DependencyBlame, DependencyCulprit, JourneyStepId } from './types';

export function classifyDependencyBlame(params: {
  stepId: JourneyStepId;
  error?: unknown;
  durationMs: number;
  slaThresholdMs: number;
  details?: Record<string, unknown>;
}): DependencyBlame {
  const { stepId, error, durationMs, slaThresholdMs, details } = params;
  const errorMessage = error instanceof Error ? error.message : String(error || '');

  // 1. Check for Latency SLA Breach (Degraded state) if there is no hard error
  if (!error) {
    if (durationMs > slaThresholdMs) {
      return buildLatencyBlame(stepId, durationMs, slaThresholdMs, details);
    }
    return {
      culprit: defaultCulpritForStep(stepId),
      severity: 'info',
      confidence: 1.0,
      retriable: true,
      reason: `Step completed successfully in ${durationMs}ms (within SLA ${slaThresholdMs}ms).`,
      suggestedRemediation: 'No remediation needed.',
      details,
    };
  }

  // 2. Classify Hard Failure based on Error patterns and Step Context
  const lowerMsg = errorMessage.toLowerCase();

  // Network / Transport level errors
  if (
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('etimedout') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('fetch failed') ||
    lowerMsg.includes('network error')
  ) {
    return {
      culprit: 'network',
      severity: 'critical',
      confidence: 0.95,
      retriable: true,
      reason: `Network transport failure during ${stepId}: ${errorMessage}`,
      suggestedRemediation:
        'Verify outbound internet connectivity, internal DNS resolution, and firewall egress rules.',
      details: { ...details, rawError: errorMessage },
    };
  }

  // Step-specific error classifications:
  switch (stepId) {
    case 'wallet_session_check': {
      const isFormat = lowerMsg.includes('invalid') || lowerMsg.includes('address') || lowerMsg.includes('public key');
      const isBalance = lowerMsg.includes('balance') || lowerMsg.includes('unfunded') || lowerMsg.includes('below minimum');
      return {
        culprit: 'wallet-session',
        severity: 'critical',
        confidence: 0.98,
        retriable: isBalance ? true : false,
        reason: isBalance
          ? `Account balance insufficient for minimum reserve or transaction: ${errorMessage}`
          : `Wallet session or public key validation failed: ${errorMessage}`,
        suggestedRemediation: isBalance
          ? 'Fund the test/active Stellar account with native XLM via Friendbot or treasury.'
          : 'Ensure active wallet extension is unlocked, connected, and has an active Ed25519 public key.',
        details: { ...details, rawError: errorMessage },
      };
    }

    case 'catalog_agent_lookup': {
      return {
        culprit: 'marketplace-catalog',
        severity: 'critical',
        confidence: 0.95,
        retriable: true,
        reason: `Marketplace catalog lookup failed: ${errorMessage}`,
        suggestedRemediation:
          'Verify search index health, PostgreSQL/KV database connectivity, or seed catalogue fixtures.',
        details: { ...details, rawError: errorMessage },
      };
    }

    case 'ipfs_metadata_fetch': {
      const isGatewayTimeout =
        lowerMsg.includes('timeout') || lowerMsg.includes('504') || lowerMsg.includes('502');
      return {
        culprit: 'ipfs-gateway',
        severity: 'critical',
        confidence: 0.96,
        retriable: true,
        reason: isGatewayTimeout
          ? `IPFS gateway timed out while retrieving metadata CID: ${errorMessage}`
          : `IPFS metadata retrieval or manifest parsing failed: ${errorMessage}`,
        suggestedRemediation:
          'Check IPFS cluster/gateway health, verify CID pinning on pinning service (Pinata/Web3.Storage), or switch to fallback gateway URL.',
        details: { ...details, rawError: errorMessage },
      };
    }

    case 'protocol_guard_evaluation': {
      const isPaused = lowerMsg.includes('paused') || lowerMsg.includes('emergency');
      const isAbuse = lowerMsg.includes('abuse') || lowerMsg.includes('risk');
      const isConfig = lowerMsg.includes('config') || lowerMsg.includes('version');
      return {
        culprit: 'protocol-guard',
        severity: 'critical',
        confidence: 0.99,
        retriable: isPaused || isAbuse ? false : true,
        reason: isPaused
          ? `Operation is blocked by active emergency pause: ${errorMessage}`
          : isAbuse
          ? `Operation rejected by risk-scored abuse detection: ${errorMessage}`
          : isConfig
          ? `Protocol configuration version incompatibility: ${errorMessage}`
          : `Protocol safety preflight guard rejected execution: ${errorMessage}`,
        suggestedRemediation: isPaused
          ? 'Check protocol emergency pause status in the Governance dashboard; unpause operation if safe.'
          : isAbuse
          ? 'Review abuse detection heuristics or supply valid step-up verification proof.'
          : 'Align frontend protocol config versions with deployed on-chain contract versions.',
        details: { ...details, rawError: errorMessage },
      };
    }

    case 'soroban_preflight_simulation': {
      const isResource =
        lowerMsg.includes('budget') ||
        lowerMsg.includes('resource') ||
        lowerMsg.includes('energy') ||
        lowerMsg.includes('footprint');
      const isContract =
        lowerMsg.includes('trap') || lowerMsg.includes('vm') || lowerMsg.includes('contract');
      return {
        culprit: 'soroban-rpc',
        severity: 'critical',
        confidence: 0.95,
        retriable: isResource ? true : false,
        reason: isResource
          ? `Soroban RPC simulation failed resource limits or CPU budget: ${errorMessage}`
          : isContract
          ? `Soroban smart contract execution failed or trapped during simulation: ${errorMessage}`
          : `Soroban RPC simulation endpoint error: ${errorMessage}`,
        suggestedRemediation: isResource
          ? 'Adjust transaction resource fee allocation or optimize contract instructions and read/write footprints.'
          : 'Check Soroban RPC server status, contract deployment state, and invocation arguments.',
        details: { ...details, rawError: errorMessage },
      };
    }

    case 'transaction_submission': {
      const isHorizonRateLimit = lowerMsg.includes('429') || lowerMsg.includes('rate limit');
      const isBadSeq = lowerMsg.includes('txbad_seq') || lowerMsg.includes('sequence');
      const isExpired = lowerMsg.includes('txtoo_late') || lowerMsg.includes('expired');
      const isHorizon =
        isHorizonRateLimit || isBadSeq || isExpired || lowerMsg.includes('horizon');

      if (isHorizon) {
        return {
          culprit: 'stellar-horizon',
          severity: 'critical',
          confidence: 0.92,
          retriable: isHorizonRateLimit || isBadSeq ? true : false,
          reason: isHorizonRateLimit
            ? 'Stellar Horizon API rate limit encountered (HTTP 429).'
            : isBadSeq
            ? 'Account sequence number mismatch on Stellar ledger.'
            : `Stellar Horizon transaction submission failed: ${errorMessage}`,
          suggestedRemediation: isHorizonRateLimit
            ? 'Enable backoff jitter or configure dedicated Horizon RPC node.'
            : isBadSeq
            ? 'Refresh source account sequence from Horizon before rebuilding transaction.'
            : 'Check Horizon network health, transaction memo/signatures, and fee parameters.',
          details: { ...details, rawError: errorMessage },
        };
      }

      return {
        culprit: 'soroban-rpc',
        severity: 'critical',
        confidence: 0.88,
        retriable: true,
        reason: `Transaction broadcast or confirmation timed out: ${errorMessage}`,
        suggestedRemediation:
          'Inspect Stellar Core / Soroban validator logs and transaction status endpoint.',
        details: { ...details, rawError: errorMessage },
      };
    }

    case 'post_execution_state_verification': {
      return {
        culprit: 'ledger-state',
        severity: 'critical',
        confidence: 0.97,
        retriable: true,
        reason: `Post-execution ledger state invariant breached: ${errorMessage}`,
        suggestedRemediation:
          'Audit contract event emission, ledger entry indexing delay, and balance delta accounting.',
        details: { ...details, rawError: errorMessage },
      };
    }

    default: {
      return {
        culprit: defaultCulpritForStep(stepId),
        severity: 'critical',
        confidence: 0.8,
        retriable: true,
        reason: `Unexpected failure during ${stepId}: ${errorMessage}`,
        suggestedRemediation: 'Check system logs and retry.',
        details: { ...details, rawError: errorMessage },
      };
    }
  }
}

function defaultCulpritForStep(stepId: JourneyStepId): DependencyCulprit {
  switch (stepId) {
    case 'wallet_session_check':
      return 'wallet-session';
    case 'catalog_agent_lookup':
      return 'marketplace-catalog';
    case 'ipfs_metadata_fetch':
      return 'ipfs-gateway';
    case 'protocol_guard_evaluation':
      return 'protocol-guard';
    case 'soroban_preflight_simulation':
      return 'soroban-rpc';
    case 'transaction_submission':
      return 'stellar-horizon';
    case 'post_execution_state_verification':
      return 'ledger-state';
    default:
      return 'network';
  }
}

function buildLatencyBlame(
  stepId: JourneyStepId,
  durationMs: number,
  slaThresholdMs: number,
  details?: Record<string, unknown>,
): DependencyBlame {
  const culprit = defaultCulpritForStep(stepId);
  const percentOver = Math.round(((durationMs - slaThresholdMs) / slaThresholdMs) * 100);

  return {
    culprit,
    severity: percentOver > 100 ? 'critical' : 'warning',
    confidence: 0.9,
    retriable: true,
    reason: `SLA breach in ${stepId}: took ${durationMs}ms (threshold: ${slaThresholdMs}ms, +${percentOver}% overhead).`,
    suggestedRemediation: getLatencyRemediation(culprit),
    details: {
      ...details,
      durationMs,
      slaThresholdMs,
      percentOver,
    },
  };
}

function getLatencyRemediation(culprit: DependencyCulprit): string {
  switch (culprit) {
    case 'wallet-session':
      return 'Investigate browser storage contention or wallet extension communication latency.';
    case 'marketplace-catalog':
      return 'Check database query execution plans, cache hit ratio, and Redis connection pool.';
    case 'ipfs-gateway':
      return 'Implement aggressive IPFS gateway caching (Cloudflare/Fastly) or multi-gateway racing.';
    case 'protocol-guard':
      return 'Optimize preflight rule evaluation and cache config version signatures.';
    case 'soroban-rpc':
      return 'Scale Soroban RPC node capacity or tune simulated CPU/memory instruction budgets.';
    case 'stellar-horizon':
      return 'Verify Horizon node ingestion lag and network round-trip latency to validators.';
    case 'ledger-state':
      return 'Check ledger polling backoff parameters and indexing ingestion delay.';
    default:
      return 'Profile upstream network latency and inspect infrastructure metrics.';
  }
}
