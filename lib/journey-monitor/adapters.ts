/**
 * Default adapters for the synthetic journey monitor.
 *
 * Provides deterministic, dependency-injectable implementations of all
 * subsystem interfaces so the monitor can execute in CI, local developer environments,
 * scheduled cron jobs, and production canary pipelines.
 */

import type { AgentListing, AgentMetadataManifest, JourneyAdapters, JourneyStepId } from './types';
import { isValidStellarAddress } from './validators';

export const SYNTHETIC_ACTOR_PUBLIC_KEY =
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const SYNTHETIC_AGENT_ID = 'agent-synthetic-alpha-01';
export const SYNTHETIC_METADATA_CID = 'QmX5kkqbvJ5vY5K5v5kK5v5kK5v5kK5v5kK5v5kK5v5kK';

export interface AdapterOptions {
  scenario?:
    | 'healthy'
    | 'wallet_invalid'
    | 'wallet_unfunded'
    | 'catalog_missing'
    | 'ipfs_down'
    | 'emergency_paused'
    | 'abuse_risk'
    | 'rpc_timeout'
    | 'rpc_resource_exceeded'
    | 'horizon_rate_limited'
    | 'horizon_bad_seq'
    | 'state_desync'
    | 'high_latency';
  stepDelaysMs?: Partial<Record<JourneyStepId, number>>;
  customActorPublicKey?: string;
}

export function createDefaultAdapters(options: AdapterOptions = {}): JourneyAdapters {
  const scenario = options.scenario || 'healthy';
  const delays = options.stepDelaysMs || {};
  const actorPublicKey = options.customActorPublicKey || SYNTHETIC_ACTOR_PUBLIC_KEY;

  async function applyDelay(step: JourneyStepId, defaultMs = 5): Promise<void> {
    const ms = delays[step] ?? defaultMs;
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  const sampleAgent: AgentListing = {
    id: SYNTHETIC_AGENT_ID,
    name: 'Alpha Trader Synthetic Agent',
    version: '1.2.0',
    description: 'High-throughput Soroban DEX liquidity and arbitrage agent.',
    creatorPublicKey: actorPublicKey,
    ipfsCid: SYNTHETIC_METADATA_CID,
    priceXlm: '50.0000000',
    royaltyPercent: 5,
  };

  const sampleMetadata: AgentMetadataManifest = {
    name: 'Alpha Trader Synthetic Agent',
    version: '1.2.0',
    description: 'High-throughput Soroban DEX liquidity and arbitrage agent.',
    capabilities: ['market_analysis', 'dex_arbitrage', 'soroban_invocation'],
    systemPromptHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    createdAt: '2026-10-15T12:00:00.000Z',
  };

  return {
    wallet: {
      async getAddress(): Promise<string> {
        await applyDelay('wallet_session_check');
        if (scenario === 'wallet_invalid') {
          throw new Error('Invalid Stellar public key format: MALFORMED_ADDRESS_G000');
        }
        return actorPublicKey;
      },
      async getBalances(address: string): Promise<Array<{ asset: string; balance: string }>> {
        await applyDelay('wallet_session_check');
        if (!isValidStellarAddress(address)) {
          throw new Error(`Invalid public key: ${address}`);
        }
        if (scenario === 'wallet_unfunded') {
          return [{ asset: 'native', balance: '0.5000000' }]; // Below minimum reserve
        }
        return [
          { asset: 'native', balance: '1250.7500000' },
          { asset: 'USDC', balance: '500.0000000' },
        ];
      },
    },

    catalog: {
      async getAgent(agentId: string): Promise<AgentListing | null> {
        await applyDelay('catalog_agent_lookup');
        if (scenario === 'catalog_missing' || agentId !== SYNTHETIC_AGENT_ID) {
          throw new Error(`Agent listing not found in catalog: ${agentId}`);
        }
        return sampleAgent;
      },
      async listAgents(): Promise<AgentListing[]> {
        await applyDelay('catalog_agent_lookup');
        if (scenario === 'catalog_missing') {
          return [];
        }
        return [sampleAgent];
      },
    },

    ipfs: {
      async fetchMetadata(cid: string): Promise<AgentMetadataManifest> {
        await applyDelay('ipfs_metadata_fetch');
        if (scenario === 'ipfs_down') {
          throw new Error(
            `IPFS gateway 504 Gateway Timeout: unable to retrieve CID ${cid} within deadline`,
          );
        }
        return sampleMetadata;
      },
    },

    protocolGuard: {
      async evaluate(params): Promise<{ allowed: boolean; reason?: string }> {
        await applyDelay('protocol_guard_evaluation');
        if (scenario === 'emergency_paused') {
          throw new Error(
            `Operation '${params.operation}' is paused by governance emergency control.`,
          );
        }
        if (scenario === 'abuse_risk') {
          throw new Error(
            `Abuse risk score 88 exceeded threshold: velocity limit on ${params.operation}.`,
          );
        }
        return { allowed: true };
      },
    },

    sorobanRpc: {
      async simulateTransaction(): Promise<{
        success: boolean;
        minResourceFee: string;
        cpuInstructions: number;
        readBytes: number;
        error?: string;
      }> {
        await applyDelay('soroban_preflight_simulation');
        if (scenario === 'rpc_timeout') {
          throw new Error('Soroban RPC simulation request timed out after 5000ms');
        }
        if (scenario === 'rpc_resource_exceeded') {
          throw new Error(
            'Soroban simulation error: RESOURCE_LIMIT_EXCEEDED (CPU instructions 125,000,000 exceeds ledger limit)',
          );
        }
        return {
          success: true,
          minResourceFee: '15000',
          cpuInstructions: 1_250_000,
          readBytes: 4096,
        };
      },
    },

    horizon: {
      async submitTransaction(): Promise<{
        hash: string;
        successful: boolean;
        ledger: number;
        error?: string;
      }> {
        await applyDelay('transaction_submission');
        if (scenario === 'horizon_rate_limited') {
          throw new Error('Stellar Horizon HTTP 429 Too Many Requests (Rate limit exceeded)');
        }
        if (scenario === 'horizon_bad_seq') {
          throw new Error('Stellar Horizon txBAD_SEQ: source account sequence is invalid');
        }
        return {
          hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          successful: true,
          ledger: 1042589,
        };
      },
      async getTransactionStatus(hash: string): Promise<{
        status: 'confirmed' | 'pending' | 'failed';
        ledger?: number;
        error?: string;
      }> {
        await applyDelay('transaction_submission', 2);
        return {
          status: 'confirmed',
          ledger: 1042589,
        };
      },
    },

    ledger: {
      async verifyState(agentId: string, expectedOwner: string): Promise<{
        verified: boolean;
        currentOwner: string;
        balanceVerified: boolean;
      }> {
        await applyDelay('post_execution_state_verification');
        if (scenario === 'state_desync') {
          throw new Error(
            `Ledger state mismatch: expected owner ${expectedOwner}, found GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`,
          );
        }
        return {
          verified: true,
          currentOwner: expectedOwner,
          balanceVerified: true,
        };
      },
    },
  };
}
