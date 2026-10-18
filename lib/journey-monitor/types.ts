/**
 * Types and interfaces for the Trellis Synthetic Journey Monitor.
 *
 * Models the end-to-end critical user journey across wallet hydration,
 * marketplace catalog discovery, IPFS metadata retrieval, protocol safety guard,
 * Soroban RPC preflight simulation, transaction execution/receipting, and
 * post-execution state verification.
 */

import type { ProtocolOperation, ProtocolEnvironment, ProtocolActor } from '../protocol/operations';

export type JourneyStepId =
  | 'wallet_session_check'
  | 'catalog_agent_lookup'
  | 'ipfs_metadata_fetch'
  | 'protocol_guard_evaluation'
  | 'soroban_preflight_simulation'
  | 'transaction_submission'
  | 'post_execution_state_verification';

export const JOURNEY_STEPS: readonly JourneyStepId[] = [
  'wallet_session_check',
  'catalog_agent_lookup',
  'ipfs_metadata_fetch',
  'protocol_guard_evaluation',
  'soroban_preflight_simulation',
  'transaction_submission',
  'post_execution_state_verification',
] as const;

export type DependencyCulprit =
  | 'wallet-session'
  | 'marketplace-catalog'
  | 'ipfs-gateway'
  | 'protocol-guard'
  | 'soroban-rpc'
  | 'stellar-horizon'
  | 'receipt-service'
  | 'ledger-state'
  | 'network';

export type StepStatus = 'passed' | 'failed' | 'degraded';
export type JourneyStatus = 'healthy' | 'degraded' | 'failed';

export interface DependencyBlame {
  culprit: DependencyCulprit;
  severity: 'critical' | 'warning' | 'info';
  confidence: number; // 0.0 to 1.0
  retriable: boolean;
  reason: string;
  suggestedRemediation: string;
  details?: Record<string, unknown>;
}

export interface JourneyStepResult {
  stepId: JourneyStepId;
  name: string;
  status: StepStatus;
  durationMs: number;
  slaThresholdMs: number;
  dependency: DependencyCulprit;
  error?: string;
  blame?: DependencyBlame;
  data?: Record<string, unknown>;
}

export interface SyntheticJourneyResult {
  journeyId: string;
  workflow: string;
  status: JourneyStatus;
  totalDurationMs: number;
  totalSlaThresholdMs: number;
  startedAt: string;
  completedAt: string;
  steps: JourneyStepResult[];
  blame?: DependencyBlame;
  metadata: {
    network: string;
    environment: ProtocolEnvironment;
    actorPublicKey?: string;
    agentId?: string;
    simulated: boolean;
  };
}

export interface SlaConfig {
  walletSessionMs: number;
  catalogLookupMs: number;
  ipfsFetchMs: number;
  protocolGuardMs: number;
  sorobanPreflightMs: number;
  transactionSubmissionMs: number;
  stateVerificationMs: number;
  totalJourneyMs: number;
}

export interface AgentListing {
  id: string;
  name: string;
  version: string;
  description: string;
  creatorPublicKey: string;
  ipfsCid: string;
  priceXlm: string;
  royaltyPercent: number;
}

export interface AgentMetadataManifest {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  systemPromptHash?: string;
  createdAt: string;
}

export interface JourneyAdapters {
  wallet: {
    getAddress(): Promise<string>;
    getBalances(address: string): Promise<Array<{ asset: string; balance: string }>>;
  };
  catalog: {
    getAgent(agentId: string): Promise<AgentListing | null>;
    listAgents(): Promise<AgentListing[]>;
  };
  ipfs: {
    fetchMetadata(cid: string): Promise<AgentMetadataManifest>;
  };
  protocolGuard: {
    evaluate(params: {
      operation: ProtocolOperation;
      environment: ProtocolEnvironment;
      actor: ProtocolActor;
      payload: Record<string, unknown>;
      configVersions: Record<string, string>;
    }): Promise<{ allowed: boolean; reason?: string }>;
  };
  sorobanRpc: {
    simulateTransaction(params: {
      contractId: string;
      method: string;
      args: unknown[];
    }): Promise<{
      success: boolean;
      minResourceFee: string;
      cpuInstructions: number;
      readBytes: number;
      error?: string;
    }>;
  };
  horizon: {
    submitTransaction(params: {
      transactionXdr: string;
    }): Promise<{
      hash: string;
      successful: boolean;
      ledger: number;
      error?: string;
    }>;
    getTransactionStatus(hash: string): Promise<{
      status: 'confirmed' | 'pending' | 'failed';
      ledger?: number;
      error?: string;
    }>;
  };
  ledger: {
    verifyState(agentId: string, expectedOwner: string): Promise<{
      verified: boolean;
      currentOwner: string;
      balanceVerified: boolean;
    }>;
  };
  clock?: () => number;
}

export interface SyntheticJourneyConfig {
  workflowName?: string;
  environment?: ProtocolEnvironment;
  network?: string;
  actorPublicKey?: string;
  agentId?: string;
  slaConfig?: Partial<SlaConfig>;
  timeoutMs?: number;
  strictSla?: boolean;
}

export interface JourneyMetricsSnapshot {
  totalRuns: number;
  passedRuns: number;
  degradedRuns: number;
  failedRuns: number;
  availabilityPercent: number;
  meanDurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  blameDistribution: Record<DependencyCulprit, number>;
  stepAveragesMs: Record<JourneyStepId, number>;
  lastRun?: SyntheticJourneyResult;
}
