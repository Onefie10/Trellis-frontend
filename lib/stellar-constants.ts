import { StellarNetworkConfig, StellarNetwork } from "./types";

// Stellar Network Configurations
const parseFallbackRpcUrls = (value?: string): string[] =>
  (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const STELLAR_NETWORKS: Record<string, StellarNetworkConfig> = {
  mainnet: {
    name: "mainnet",
    displayName: "Mainnet",
    horizonUrl:
      process.env.NEXT_PUBLIC_STELLAR_MAINNET_URL ||
      "https://horizon.stellar.org",
    rpcUrl:
      process.env.NEXT_PUBLIC_STELLAR_MAINNET_RPC_URL ||
      "https://horizon.stellar.org".replace("horizon", "soroban-rpc"),
    rpcFallbackUrls: parseFallbackRpcUrls(process.env.NEXT_PUBLIC_STELLAR_MAINNET_RPC_FALLBACKS),
    networkPassphrase:
      process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE_MAINNET ||
      "Public Global Stellar Network ; September 2015",
    color: "bg-blue-600",
    badge: "🟦 Mainnet",
  },
  testnet: {
    name: "testnet",
    displayName: "Testnet",
    horizonUrl:
      process.env.NEXT_PUBLIC_STELLAR_TESTNET_URL ||
      "https://horizon-testnet.stellar.org",
    rpcUrl:
      process.env.NEXT_PUBLIC_STELLAR_TESTNET_RPC_URL ||
      "https://soroban-testnet.stellar.org",
    rpcFallbackUrls: parseFallbackRpcUrls(process.env.NEXT_PUBLIC_STELLAR_TESTNET_RPC_FALLBACKS),
    networkPassphrase:
      process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE_TESTNET ||
      "Test SDF Network ; September 2015",
    color: "bg-yellow-500",
    badge: "🟨 Testnet",
  },
  futurenet: {
    name: "futurenet",
    displayName: "Futurenet",
    horizonUrl:
      process.env.NEXT_PUBLIC_STELLAR_FUTURENET_URL ||
      "https://horizon-futurenet.stellar.org",
    rpcUrl:
      process.env.NEXT_PUBLIC_STELLAR_FUTURENET_RPC_URL ||
      "https://rpc-futurenet.stellar.org",
    rpcFallbackUrls: parseFallbackRpcUrls(process.env.NEXT_PUBLIC_STELLAR_FUTURENET_RPC_FALLBACKS),
    networkPassphrase:
      process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE_FUTURENET ||
      "Test SDF Future Network ; October 2022",
    color: "bg-purple-600",
    badge: "🟪 Futurenet",
  },
};

export const SOROBAN_RPC_CONFIG = {
  latencyThresholdMs: Number(process.env.NEXT_PUBLIC_SOROBAN_RPC_LATENCY_THRESHOLD_MS || 3000),
  maxRetries: Number(process.env.NEXT_PUBLIC_SOROBAN_RPC_MAX_RETRIES || 3),
  baseBackoffMs: Number(process.env.NEXT_PUBLIC_SOROBAN_RPC_BASE_BACKOFF_MS || 250),
  healthCheckIntervalMs: Number(process.env.NEXT_PUBLIC_SOROBAN_RPC_HEALTHCHECK_INTERVAL_MS || 30000),
} as const;

// Default network - ensure it's a valid network value
const defaultNetworkValue = (process.env.NEXT_PUBLIC_DEFAULT_STELLAR_NETWORK ||
  "mainnet") as string;
export const DEFAULT_NETWORK: StellarNetwork = (
  ["mainnet", "testnet", "futurenet"].includes(defaultNetworkValue)
    ? defaultNetworkValue
    : "mainnet"
) as StellarNetwork;

// Wallet types
export const WALLET_TYPES = {
  FREIGHTER: "freighter",
  ALBEDO: "albedo",
  LEDGER: "ledger",
} as const;

// Local Storage Keys
export const STORAGE_KEYS = {
  WALLET_ADDRESS: "stellar_wallet_address",
  WALLET_TYPE: "stellar_wallet_type",
  NETWORK: "stellar_network",
  WALLET_STATE: "stellar_wallet_state",
  LINKED_WALLETS: "stellar_linked_wallets",
  DELEGATIONS: "stellar_delegations",
  SESSION_RECOVERY: "stellar_session_recovery",
} as const;

// XLM Asset
export const XLM_ASSET = {
  code: "XLM",
  issuer: undefined, // XLM is native
  name: "Lumens",
} as const;

// Common Stellar Assets
export const STELLAR_ASSETS = {
  XLM: { code: "XLM", name: "Lumens" },
  USDC: {
    code: "USDC",
    issuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABVQVDF3YKBE6",
    name: "USD Coin",
  },
  SRT: {
    code: "SRT",
    issuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABVQVDF3YKBE6",
    name: "Stellar",
  },
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  WALLET_NOT_INSTALLED: "Wallet extension not found. Please install it first.",
  USER_REJECTED: "Transaction was rejected by the user.",
  NETWORK_ERROR: "Network error. Please try again.",
  INVALID_ADDRESS: "Invalid Stellar address.",
  INSUFFICIENT_BALANCE: "Insufficient balance for this transaction.",
  UNKNOWN_ERROR: "An unknown error occurred. Please try again.",
} as const;

// Block Explorers
//
// Each network maps to the StellarExpert explorer segment and to the Horizon
// instance operated by Stellar.org, which serves the canonical JSON record for
// every transaction and ledger. StellarExpert does not index Futurenet, so that
// network links to Horizon only.
export type BlockExplorerId = "stellarExpert" | "stellarOrg";

export interface BlockExplorerLink {
  explorer: BlockExplorerId;
  label: string;
  url: string;
}

export const BLOCK_EXPLORERS: Record<
  StellarNetwork,
  { stellarExpert: string | null; stellarOrg: string }
> = {
  mainnet: {
    stellarExpert: "https://stellar.expert/explorer/public",
    stellarOrg: STELLAR_NETWORKS.mainnet.horizonUrl,
  },
  testnet: {
    stellarExpert: "https://stellar.expert/explorer/testnet",
    stellarOrg: STELLAR_NETWORKS.testnet.horizonUrl,
  },
  futurenet: {
    stellarExpert: null,
    stellarOrg: STELLAR_NETWORKS.futurenet.horizonUrl,
  },
};

export const BLOCK_EXPLORER_LABELS: Record<BlockExplorerId, string> = {
  stellarExpert: "StellarExpert",
  stellarOrg: "Stellar.org Horizon",
};

const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/** A Stellar transaction hash is 32 bytes, hex encoded. */
export function isValidTransactionHash(hash: unknown): hash is string {
  return typeof hash === "string" && TX_HASH_PATTERN.test(hash.trim());
}

/** Ledger sequence numbers are positive 32-bit integers. */
export function isValidLedgerSequence(ledger: unknown): ledger is number {
  return (
    typeof ledger === "number" &&
    Number.isInteger(ledger) &&
    ledger > 0 &&
    ledger <= 0xffffffff
  );
}

function resolveExplorerNetwork(network: string): StellarNetwork {
  const normalised = network.trim().toLowerCase();
  if (normalised === "public" || normalised === "pubnet") return "mainnet";
  if (normalised in BLOCK_EXPLORERS) return normalised as StellarNetwork;
  throw new Error(`Unsupported Stellar network for block explorer: ${network}`);
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Explorer URL for a transaction, or `null` when the hash or explorer is invalid. */
export function getExplorerTransactionUrl(
  network: string,
  hash: string,
  explorer: BlockExplorerId = "stellarExpert",
): string | null {
  if (!isValidTransactionHash(hash)) return null;
  const base = BLOCK_EXPLORERS[resolveExplorerNetwork(network)][explorer];
  if (!base) return null;
  const normalisedHash = hash.trim().toLowerCase();
  return explorer === "stellarExpert"
    ? `${trimTrailingSlash(base)}/tx/${normalisedHash}`
    : `${trimTrailingSlash(base)}/transactions/${normalisedHash}`;
}

/** Explorer URL for a ledger (block), or `null` when the sequence is invalid. */
export function getExplorerLedgerUrl(
  network: string,
  ledger: number,
  explorer: BlockExplorerId = "stellarExpert",
): string | null {
  if (!isValidLedgerSequence(ledger)) return null;
  const base = BLOCK_EXPLORERS[resolveExplorerNetwork(network)][explorer];
  if (!base) return null;
  return explorer === "stellarExpert"
    ? `${trimTrailingSlash(base)}/ledger/${ledger}`
    : `${trimTrailingSlash(base)}/ledgers/${ledger}`;
}

/** StellarExpert contract page, or `null` for invalid ids / unsupported networks. */
export function getExplorerContractUrl(network: string, contractId: string): string | null {
  if (!CONTRACT_ID_PATTERN.test(contractId)) return null;
  const base = BLOCK_EXPLORERS[resolveExplorerNetwork(network)].stellarExpert;
  return base ? `${trimTrailingSlash(base)}/contract/${contractId}` : null;
}

/** Every explorer link available for a transaction on `network`. */
export function getTransactionExplorerLinks(network: string, hash: string): BlockExplorerLink[] {
  return (Object.keys(BLOCK_EXPLORER_LABELS) as BlockExplorerId[]).flatMap((explorer) => {
    const url = getExplorerTransactionUrl(network, hash, explorer);
    return url ? [{ explorer, label: BLOCK_EXPLORER_LABELS[explorer], url }] : [];
  });
}
