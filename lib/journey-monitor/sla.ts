/**
 * SLA thresholds and latency budget evaluations for synthetic journeys.
 */

import type { JourneyStepId, SlaConfig } from './types';

export const DEFAULT_SLA_CONFIG: Readonly<SlaConfig> = {
  walletSessionMs: 250,
  catalogLookupMs: 350,
  ipfsFetchMs: 800,
  protocolGuardMs: 200,
  sorobanPreflightMs: 1200,
  transactionSubmissionMs: 2500,
  stateVerificationMs: 300,
  totalJourneyMs: 5000,
};

export function resolveSlaThreshold(
  stepId: JourneyStepId,
  config: SlaConfig = DEFAULT_SLA_CONFIG,
): number {
  switch (stepId) {
    case 'wallet_session_check':
      return config.walletSessionMs;
    case 'catalog_agent_lookup':
      return config.catalogLookupMs;
    case 'ipfs_metadata_fetch':
      return config.ipfsFetchMs;
    case 'protocol_guard_evaluation':
      return config.protocolGuardMs;
    case 'soroban_preflight_simulation':
      return config.sorobanPreflightMs;
    case 'transaction_submission':
      return config.transactionSubmissionMs;
    case 'post_execution_state_verification':
      return config.stateVerificationMs;
    default:
      return 1000;
  }
}

export function mergeSlaConfig(partial?: Partial<SlaConfig>): SlaConfig {
  return {
    ...DEFAULT_SLA_CONFIG,
    ...partial,
  };
}
