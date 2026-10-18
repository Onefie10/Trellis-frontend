/**
 * Sandbox Fixtures
 *
 * Provides deterministic test data for common success and failure scenarios.
 *
 * Wallet and transaction fixtures now also cover the failure states the mock
 * wallet generator and the scenario library can produce, so a UI test can grab a
 * fixture by id instead of rebuilding the same state inline.
 */

import { WALLET_PRESETS, type MockBalanceInput } from "./sandbox-wallet";
import { SCENARIO_PRESETS } from "./sandbox-scenarios";

export interface SandboxFixture {
  id: string;
  name: string;
  description: string;
  data: Record<string, unknown>;
}

/** Placeholder issuer used by the credit-asset fixtures (not a real account). */
const FIXTURE_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const FIXTURE_EURC_ISSUER = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";
const FIXTURE_AQUA_ISSUER = "GIXCNOA72PGIK5ZMD7YRUFIJMRPTXS5HRC3TXMPWS5HEMO6RCZ4RYJIP";

function balancesFromPreset(presetId: string): MockBalanceInput[] {
  return WALLET_PRESETS.find((p) => p.id === presetId)?.input.balances ?? [];
}

export const WALLET_FIXTURES = {
  success: {
    id: "wallet-success",
    name: "Connected Wallet",
    description: "Simulates a successfully connected Stellar wallet",
    data: {
      publicKey: "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
      balances: [
        { asset: "native", balance: "1000" },
        { asset: "USDC", balance: "500" },
      ],
      network: "testnet",
    },
  },
  notFound: {
    id: "wallet-not-found",
    name: "Wallet Not Found",
    description: "Simulates wallet connection failure",
    data: {
      error: "Wallet not found",
      code: 404,
    },
  },
  lowBalance: {
    id: "wallet-low-balance",
    name: "Low XLM Balance",
    description:
      "0.8 XLM native with three trustlines — below the 2.5 XLM minimum reserve",
    data: {
      publicKey: FIXTURE_AQUA_ISSUER,
      nativeBalance: "0.8",
      minimumReserve: "2.5000000",
      spendable: "0",
      belowMinimum: true,
      balances: balancesFromPreset("low-xlm"),
      network: "testnet",
    },
  },
  noTrustlines: {
    id: "wallet-no-trustlines",
    name: "Native Only Wallet",
    description: "A funded account with no credit-asset trustlines",
    data: {
      publicKey: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
      balances: balancesFromPreset("no-trustlines"),
      trustlineCount: 0,
      network: "testnet",
    },
  },
  unauthorisedAsset: {
    id: "wallet-unauthorised-asset",
    name: "Unauthorised Trustline",
    description: "A trustline that exists but is not authorised by its issuer",
    data: {
      publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      balances: [
        { asset: "native", balance: "30" },
        { asset: "USDC", issuer: FIXTURE_USDC_ISSUER, balance: "0", authorized: false },
      ],
      failureCode: "opNOT_AUTHORIZED",
      network: "testnet",
    },
  },
  empty: {
    id: "wallet-empty",
    name: "Empty Wallet",
    description: "Zero XLM and no trustlines — the brand-new account branch",
    data: {
      publicKey: "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
      balances: balancesFromPreset("empty"),
      reserveShortfall: "2.5000000",
      network: "testnet",
    },
  },
};

export const TRANSACTION_FIXTURES = {
  success: {
    id: "txn-success",
    name: "Successful Transaction",
    description: "Simulates a successful payment transaction",
    data: {
      hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      status: "success",
      timestamp: new Date().toISOString(),
      amount: "100",
      recipient: "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
    },
  },
  insufficientBalance: {
    id: "txn-insufficient",
    name: "Insufficient Balance",
    description: "Simulates insufficient balance error",
    data: {
      error: "Insufficient balance",
      code: 400,
      available: "50",
      requested: "100",
    },
  },
  timeout: {
    id: "txn-timeout",
    name: "Network Timeout",
    description: "Simulates network timeout error",
    data: {
      error: "Request timeout",
      code: 408,
    },
  },
  outOfEnergy: {
    id: "txn-out-of-energy",
    name: "Out of Energy",
    description: "Soroban CPU/memory budget exhausted before the invocation completed",
    data: {
      scenarioId: "out_of_energy",
      transactionCode: "txFAILED",
      operationCode: "invokeHostFunction → SOROBAN_FAILED",
      diagnostic: "HostError: Error(Budget, ExceededLimit)",
      feeCharged: true,
    },
  },
  invalidSequence: {
    id: "txn-invalid-sequence",
    name: "Invalid Sequence",
    description: "Stale sequence number — another transaction from the account landed first",
    data: {
      scenarioId: "invalid_sequence",
      transactionCode: "txBAD_SEQ",
      retriable: true,
    },
  },
  txExpired: {
    id: "txn-expired",
    name: "Transaction Expired",
    description: "Timebounds were already closed when the transaction reached the ledger",
    data: {
      scenarioId: "tx_expired",
      transactionCode: "txTOO_LATE",
      retriable: true,
    },
  },
};

export const VERIFICATION_FIXTURES = {
  success: {
    id: "verify-success",
    name: "Verification Approved",
    description: "Simulates successful verification",
    data: {
      verified: true,
      timestamp: new Date().toISOString(),
      level: "standard",
    },
  },
  declined: {
    id: "verify-declined",
    name: "Verification Declined",
    description: "Simulates verification decline",
    data: {
      verified: false,
      reason: "Insufficient documentation",
      timestamp: new Date().toISOString(),
    },
  },
};

/**
 * Scenario fixtures mirror the scenario library, so the UI can list presets
 * from one place whether it wants a fixture or a scenario record.
 */
export const SCENARIO_FIXTURES: Record<string, SandboxFixture> = SCENARIO_PRESETS.reduce(
  (accumulator, scenario) => {
    accumulator[scenario.id] = {
      id: `scenario-${scenario.id}`,
      name: scenario.label,
      description: scenario.description,
      data: {
        scenarioId: scenario.id,
        category: scenario.category,
        httpStatus: scenario.httpStatus,
        status: scenario.status,
        transactionCode: scenario.transactionCode,
        operationCode: scenario.operationCode,
        soroban: scenario.soroban,
        diagnosticEvents: scenario.diagnosticEvents,
        retriable: scenario.retriable,
        hints: scenario.hints,
      },
    };
    return accumulator;
  },
  {} as Record<string, SandboxFixture>,
);

export const ALL_FIXTURES = {
  ...WALLET_FIXTURES,
  ...TRANSACTION_FIXTURES,
  ...VERIFICATION_FIXTURES,
  ...SCENARIO_FIXTURES,
};

/**
 * Every fixture keyed by its stable `id`.
 *
 * `ALL_FIXTURES` is a spread of objects that share keys (`success`, `timeout`…),
 * so later groups silently overwrite earlier ones and `getFixture("txn-success")`
 * would never resolve. The registry is built from the *values*, so every fixture
 * stays reachable. `ALL_FIXTURES` is kept for back-compat.
 */
export const FIXTURE_REGISTRY: Record<string, SandboxFixture> = [
  ...Object.values(WALLET_FIXTURES),
  ...Object.values(TRANSACTION_FIXTURES),
  ...Object.values(VERIFICATION_FIXTURES),
  ...Object.values(SCENARIO_FIXTURES),
].reduce<Record<string, SandboxFixture>>((accumulator, fixture) => {
  accumulator[fixture.id] = fixture;
  return accumulator;
}, {});

export const WALLET_FIXTURE_IDS = Object.values(WALLET_FIXTURES).map((f) => f.id);
export const TRANSACTION_FIXTURE_IDS = Object.values(TRANSACTION_FIXTURES).map((f) => f.id);
export const SCENARIO_FIXTURE_IDS = Object.values(SCENARIO_FIXTURES).map((f) => f.id);
export const ALL_FIXTURE_IDS = Object.keys(FIXTURE_REGISTRY);

/**
 * Get a fixture by ID
 */
export function getFixture(id: string): SandboxFixture | undefined {
  return FIXTURE_REGISTRY[id];
}

/**
 * List all available fixtures
 */
export function listFixtures(): SandboxFixture[] {
  return Object.values(FIXTURE_REGISTRY);
}

/** Wallet fixtures only — handy for the balance generator's preset list. */
export function listWalletFixtures(): SandboxFixture[] {
  return Object.values(WALLET_FIXTURES) as SandboxFixture[];
}

/** Fixtures whose `data.scenarioId` matches, i.e. the transaction failure set. */
export function listScenarioFixtures(): SandboxFixture[] {
  return Object.values(SCENARIO_FIXTURES) as SandboxFixture[];
}

export { FIXTURE_USDC_ISSUER, FIXTURE_EURC_ISSUER, FIXTURE_AQUA_ISSUER };
