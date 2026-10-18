/* Type definitions for the application */
import { LinkedWallet, Delegation } from "./wallet/types";

export interface Agent {
  id: string;
  name: string;
  description: string;
  author: string;
  rating: number;
  users: number;
  behavior: string;
  capabilities: string[];
  status: "active" | "inactive" | "draft";
  createdAt: string;
  updatedAt: string;
}

export interface AgentConfig {
  name: string;
  description: string;
  behavior: string;
  capabilities: string[];
}

export interface Portfolio {
  agentId: string;
  performance: number;
  interactions: number;
  lastUpdated: string;
}

export interface Tutorial {
  id: string;
  title: string;
  description: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  duration: number; // in minutes
  content: string;
  videoUrl?: string;
}

// Stellar Wallet Types
/**
 * The Stellar networks Trellis supports, as runtime values.
 *
 * This is the single source of truth. `StellarNetwork` below is derived from it
 * so the type and any runtime schema built on the same list cannot drift apart -
 * a drift that previously let `lib/domain-events` register a `network` payload
 * using a vocabulary the rest of the app could never produce.
 *
 * The keys must stay in step with `STELLAR_NETWORKS` in `lib/stellar-constants.ts`.
 */
export const STELLAR_NETWORK_IDS = ["mainnet", "testnet", "futurenet"] as const;

export type StellarNetwork = (typeof STELLAR_NETWORK_IDS)[number];

export interface StellarNetworkConfig {
  name: StellarNetwork;
  displayName: string;
  horizonUrl: string;
  rpcUrl?: string;
  rpcFallbackUrls?: string[];
  networkPassphrase: string;
  color: string;
  badge: string;
}

export interface WalletBalance {
  asset: string;
  balance: string;
  assetCode?: string;
  assetIssuer?: string;
}

export interface StellarWallet {
  publicKey: string;
  name: string;
  type: "freighter" | "albedo" | "ledger";
  isConnected: boolean;
  balances: WalletBalance[];
  network: StellarNetwork;
}

export type RpcConnectionStatus = "connected" | "degraded" | "offline";

export interface RpcConnectionStatusInfo {
  status: RpcConnectionStatus;
  activeNode: string | null;
  fallbackNodes: number;
  latencyMs: number;
  warning?: string;
  lastError?: string;
}

export interface WalletContextType {
  wallet: StellarWallet | null;
  network: StellarNetwork;
  isConnecting: boolean;
  error: string | null;
  rpcStatus: RpcConnectionStatusInfo;
  connectWallet: (
    walletType: "freighter" | "albedo" | "ledger",
  ) => Promise<void>;
  disconnectWallet: () => void;
  switchNetwork: (network: StellarNetwork) => Promise<void>;
  getBalance: () => Promise<WalletBalance[]>;
  clearError: () => void;
  // Multi-wallet & Delegation extensions
  linkedWallets: LinkedWallet[];
  delegations: Delegation[];
  linkWallet: (walletType: 'freighter' | 'albedo' | 'ledger') => Promise<void>;
  unlinkWallet: (publicKey: string) => void;
  manageDelegation: (delegation: Omit<Delegation, 'id' | 'createdAt'>) => Promise<void>;
  recoverSession: () => Promise<void>;
}

export interface TransactionResult {
  success: boolean;
  hash?: string;
  /** Ledger sequence the transaction was included in, when known. */
  ledger?: number;
  error?: string;
}

// Soroban Types
export interface SorobanContractSpec {
  id: string;
  name: string;
  fns: SorobanFunctionSpec[];
}

export interface SorobanFunctionSpec {
  name: string;
  args: { name: string; type: string }[];
  result: string;
}

export type SorobanScValType =
  | "bool" | "string" | "symbol" | "bytes" | "address" | "void"
  | "u32" | "i32" | "u64" | "i64" | "u128" | "i128" | "u256" | "i256"
  | "timepoint" | "duration";

export interface ResourceMetrics {
  cpuInstructions: number;
  ramBytes: number;
  ledgerReadBytes: number;
  ledgerWriteBytes: number;
  readCount: number;
  writeCount: number;
  costXlm: string;
  minResourceFee?: string;
}

export interface SorobanTransactionResult extends TransactionResult {
  metrics?: ResourceMetrics;
  events?: SorobanEvent[];
  isFeeBumped?: boolean;
}

export interface SorobanEvent {
  type: string;
  contractId: string;
  topics: any[];
  value: any;
}

export interface StellarAsset {
  code: string;
  issuer: string;
  name?: string;
}

// Trading Bonus Types
export enum BonusType {
  REFERRAL = 'Referral',
  TRADING_VOLUME = 'Trading Volume',
  STAKING = 'Staking',
  LOYALTY = 'Loyalty',
  QUEST = 'Quest',
}

export interface TradingBonus {
  id: string;
  type: BonusType;
  amount: string; // XLM or other asset amount
  asset: string;
  timestamp: string;
  status: 'earned' | 'pending' | 'projected';
  description: string;
}

export interface BonusBreakdown {
  type: BonusType;
  totalAmount: string;
  count: number;
  color: string;
}

export interface BonusHistory {
  date: string;
  amount: number;
}
