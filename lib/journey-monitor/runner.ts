/**
 * Synthetic Journey Runner for Trellis.
 *
 * Executes the critical happy path workflow across all frontend & blockchain layers:
 * 1. Wallet Session Hydration & Balance Verification
 * 2. Marketplace Catalog Agent Lookup
 * 3. IPFS Metadata Retrieval & Manifest Verification
 * 4. Protocol Guard Evaluation (Emergency Pause & Abuse Policy)
 * 5. Soroban Preflight Resource Simulation
 * 6. Transaction Submission, Broadcast & Confirmation
 * 7. Post-Execution Ledger Invariant Verification
 *
 * Emits exact millisecond step latencies, failure diagnoses, and dependency blame.
 */

import { isValidStellarAddress } from './validators';
import { createDefaultAdapters, SYNTHETIC_ACTOR_PUBLIC_KEY, SYNTHETIC_AGENT_ID } from './adapters';
import { classifyDependencyBlame } from './blame';
import { mergeSlaConfig, resolveSlaThreshold } from './sla';
import type {
  DependencyBlame,
  JourneyAdapters,
  JourneyStepId,
  JourneyStepResult,
  SyntheticJourneyConfig,
  SyntheticJourneyResult,
} from './types';

export const WORKFLOW_NAME = 'agent-acquisition-and-execution';

export async function runSyntheticJourney(
  config: SyntheticJourneyConfig = {},
  customAdapters?: Partial<JourneyAdapters>,
): Promise<SyntheticJourneyResult> {
  const clock = customAdapters?.clock || Date.now;
  const startedAtIso = new Date(clock()).toISOString();
  const journeyStart = clock();

  const fullAdapters: JourneyAdapters = {
    ...createDefaultAdapters(),
    ...customAdapters,
  };

  const slaConfig = mergeSlaConfig(config.slaConfig);
  const journeyId = `journey-${clock()}-${Math.random().toString(36).substring(2, 8)}`;
  const environment = config.environment || 'development';
  const network = config.network || 'TESTNET';
  const targetAgentId = config.agentId || SYNTHETIC_AGENT_ID;

  const steps: JourneyStepResult[] = [];
  let journeyFailed = false;
  let journeyDegraded = false;
  let primaryBlame: DependencyBlame | undefined;
  let activeActorPublicKey = config.actorPublicKey || SYNTHETIC_ACTOR_PUBLIC_KEY;

  // Helper to execute and profile a single journey step
  async function executeStep<T>(params: {
    stepId: JourneyStepId;
    name: string;
    action: () => Promise<T>;
    onSuccessData?: (res: T) => Record<string, unknown>;
  }): Promise<T | null> {
    const { stepId, name, action, onSuccessData } = params;
    const slaThresholdMs = resolveSlaThreshold(stepId, slaConfig);
    const stepStart = clock();

    try {
      const result = await action();
      const durationMs = Math.max(1, clock() - stepStart);
      const isBreached = durationMs > slaThresholdMs;

      if (isBreached) {
        journeyDegraded = true;
      }

      const stepStatus = isBreached ? 'degraded' : 'passed';
      const blame = isBreached
        ? classifyDependencyBlame({ stepId, durationMs, slaThresholdMs })
        : undefined;

      if (isBreached && !primaryBlame) {
        primaryBlame = blame;
      }

      steps.push({
        stepId,
        name,
        status: stepStatus,
        durationMs,
        slaThresholdMs,
        dependency: blame ? blame.culprit : getStepDefaultDependency(stepId),
        blame,
        data: onSuccessData ? onSuccessData(result) : undefined,
      });

      return result;
    } catch (err) {
      const durationMs = Math.max(1, clock() - stepStart);
      journeyFailed = true;

      const blame = classifyDependencyBlame({
        stepId,
        error: err,
        durationMs,
        slaThresholdMs,
      });

      if (!primaryBlame) {
        primaryBlame = blame;
      }

      steps.push({
        stepId,
        name,
        status: 'failed',
        durationMs,
        slaThresholdMs,
        dependency: blame.culprit,
        error: err instanceof Error ? err.message : String(err),
        blame,
      });

      return null;
    }
  }

  // Step 1: Wallet Session Check & Balance Verification
  const walletResult = await executeStep({
    stepId: 'wallet_session_check',
    name: 'Wallet Session & Reserve Verification',
    action: async () => {
      const address = await fullAdapters.wallet.getAddress();
      if (!isValidStellarAddress(address)) {
        throw new Error(`Invalid Stellar address format: ${address}`);
      }
      activeActorPublicKey = address;
      const balances = await fullAdapters.wallet.getBalances(address);
      const nativeBalance = balances.find((b) => b.asset === 'native');
      const numericBalance = parseFloat(nativeBalance?.balance || '0');
      if (numericBalance < 1.0) {
        throw new Error(
          `Account balance ${numericBalance} XLM is below minimum network reserve (1.0 XLM).`,
        );
      }
      return { address, balances, nativeBalance: numericBalance };
    },
    onSuccessData: (res) => ({ address: res.address, nativeBalance: res.nativeBalance }),
  });

  // Step 2: Catalog Agent Lookup
  let agentListing = null;
  if (!journeyFailed && walletResult) {
    agentListing = await executeStep({
      stepId: 'catalog_agent_lookup',
      name: 'Marketplace Agent Discovery & Parameter Lookup',
      action: async () => {
        const agent = await fullAdapters.catalog.getAgent(targetAgentId);
        if (!agent) {
          throw new Error(`Agent ${targetAgentId} not found in marketplace catalog.`);
        }
        if (!agent.ipfsCid) {
          throw new Error(`Agent ${targetAgentId} has no associated IPFS metadata CID.`);
        }
        return agent;
      },
      onSuccessData: (agent) => ({
        agentId: agent.id,
        name: agent.name,
        priceXlm: agent.priceXlm,
        ipfsCid: agent.ipfsCid,
      }),
    });
  }

  // Step 3: IPFS Metadata Retrieval & Manifest Verification
  let metadataManifest = null;
  if (!journeyFailed && agentListing) {
    metadataManifest = await executeStep({
      stepId: 'ipfs_metadata_fetch',
      name: 'IPFS Metadata & Capability Manifest Retrieval',
      action: async () => {
        const manifest = await fullAdapters.ipfs.fetchMetadata(agentListing.ipfsCid);
        if (!manifest || !manifest.capabilities || manifest.capabilities.length === 0) {
          throw new Error(
            `Malformed agent metadata: missing or empty capabilities array for CID ${agentListing.ipfsCid}`,
          );
        }
        return manifest;
      },
      onSuccessData: (manifest) => ({
        manifestName: manifest.name,
        capabilitiesCount: manifest.capabilities.length,
      }),
    });
  }

  // Step 4: Protocol Guard Evaluation (Emergency Pause, Versioning, Abuse Policy)
  let guardResult = null;
  if (!journeyFailed && metadataManifest) {
    guardResult = await executeStep({
      stepId: 'protocol_guard_evaluation',
      name: 'Protocol Safety Guard & Preflight Simulation Checks',
      action: async () => {
        const evaluation = await fullAdapters.protocolGuard.evaluate({
          operation: 'mint_agent',
          environment,
          actor: { id: activeActorPublicKey, role: 'contributor' },
          payload: { agentId: targetAgentId, ipfsCid: agentListing?.ipfsCid },
          configVersions: { 'protocol-core': '1.0.0', 'soroban-env': '20.0.0' },
        });
        if (!evaluation.allowed) {
          throw new Error(
            evaluation.reason || 'Operation rejected by protocol safety guard evaluation.',
          );
        }
        return evaluation;
      },
      onSuccessData: () => ({ guardPassed: true }),
    });
  }

  // Step 5: Soroban Preflight Simulation (Resource and fee calculation)
  let simulationResult = null;
  if (!journeyFailed && guardResult) {
    simulationResult = await executeStep({
      stepId: 'soroban_preflight_simulation',
      name: 'Soroban Smart Contract Preflight Simulation',
      action: async () => {
        const sim = await fullAdapters.sorobanRpc.simulateTransaction({
          contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
          method: 'acquire_agent',
          args: [targetAgentId, activeActorPublicKey],
        });
        if (!sim.success) {
          throw new Error(sim.error || 'Soroban RPC preflight simulation returned unsuccessful.');
        }
        return sim;
      },
      onSuccessData: (sim) => ({
        minResourceFee: sim.minResourceFee,
        cpuInstructions: sim.cpuInstructions,
        readBytes: sim.readBytes,
      }),
    });
  }

  // Step 6: Transaction Submission & Receipt Confirmation
  let submissionResult = null;
  if (!journeyFailed && simulationResult) {
    submissionResult = await executeStep({
      stepId: 'transaction_submission',
      name: 'Transaction Broadcast, Confirmation & Receipt',
      action: async () => {
        const sub = await fullAdapters.horizon.submitTransaction({
          transactionXdr: 'AAAAAgAAAAE...',
        });
        if (!sub.successful) {
          throw new Error(sub.error || 'Stellar Horizon returned transaction failure.');
        }

        const status = await fullAdapters.horizon.getTransactionStatus(sub.hash);
        if (status.status !== 'confirmed') {
          throw new Error(
            status.error || `Transaction status '${status.status}' could not be confirmed.`,
          );
        }

        return { hash: sub.hash, ledger: sub.ledger, status: status.status };
      },
      onSuccessData: (sub) => ({ txHash: sub.hash, ledger: sub.ledger }),
    });
  }

  // Step 7: Post-Execution Ledger Invariant Verification
  if (!journeyFailed && submissionResult) {
    await executeStep({
      stepId: 'post_execution_state_verification',
      name: 'Post-Execution State & Invariant Verification',
      action: async () => {
        const state = await fullAdapters.ledger.verifyState(targetAgentId, activeActorPublicKey);
        if (!state.verified) {
          throw new Error(
            `State verification mismatch for agent ${targetAgentId}: expected owner ${activeActorPublicKey}, observed ${state.currentOwner}`,
          );
        }
        return state;
      },
      onSuccessData: (state) => ({
        verified: state.verified,
        currentOwner: state.currentOwner,
      }),
    });
  }

  const completedAtIso = new Date(clock()).toISOString();
  const totalDurationMs = Math.max(1, clock() - journeyStart);

  if (totalDurationMs > slaConfig.totalJourneyMs) {
    journeyDegraded = true;
    if (!primaryBlame) {
      primaryBlame = {
        culprit: 'network',
        severity: 'warning',
        confidence: 0.85,
        retriable: true,
        reason: `Overall journey duration ${totalDurationMs}ms exceeded SLA target of ${slaConfig.totalJourneyMs}ms.`,
        suggestedRemediation:
          'Inspect aggregate latency bottlenecks across Soroban RPC and IPFS gateways.',
        details: { totalDurationMs, slaTargetMs: slaConfig.totalJourneyMs },
      };
    }
  }

  let finalStatus: SyntheticJourneyResult['status'] = 'healthy';
  if (journeyFailed) {
    finalStatus = 'failed';
  } else if (journeyDegraded) {
    finalStatus = config.strictSla ? 'failed' : 'degraded';
  }

  return {
    journeyId,
    workflow: config.workflowName || WORKFLOW_NAME,
    status: finalStatus,
    totalDurationMs,
    totalSlaThresholdMs: slaConfig.totalJourneyMs,
    startedAt: startedAtIso,
    completedAt: completedAtIso,
    steps,
    blame: primaryBlame,
    metadata: {
      network,
      environment,
      actorPublicKey: activeActorPublicKey,
      agentId: targetAgentId,
      simulated: true,
    },
  };
}

function getStepDefaultDependency(stepId: JourneyStepId) {
  switch (stepId) {
    case 'wallet_session_check':
      return 'wallet-session' as const;
    case 'catalog_agent_lookup':
      return 'marketplace-catalog' as const;
    case 'ipfs_metadata_fetch':
      return 'ipfs-gateway' as const;
    case 'protocol_guard_evaluation':
      return 'protocol-guard' as const;
    case 'soroban_preflight_simulation':
      return 'soroban-rpc' as const;
    case 'transaction_submission':
      return 'stellar-horizon' as const;
    case 'post_execution_state_verification':
      return 'ledger-state' as const;
    default:
      return 'network' as const;
  }
}
