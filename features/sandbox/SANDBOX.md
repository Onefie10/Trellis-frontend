# Sandbox Mode

Integration sandbox for safe contributor testing without production dependencies.

## Setup

Enable sandbox mode by setting the environment variable:

```bash
NEXT_PUBLIC_SANDBOX_MODE=enabled
```

### Modes

- `disabled`: Production mode (default)
- `enabled`: Full sandbox with mock services and fake data
- `mock_only`: Mock external services but use real data logic

### Environment Variables

```bash
# Enable sandbox mode
NEXT_PUBLIC_SANDBOX_MODE=enabled

# Optional: Enable request logging
NEXT_PUBLIC_SANDBOX_LOG_REQUESTS=true
```

## Available Fixtures

Use sandbox fixtures to test common scenarios:

```typescript
import { getFixture, listFixtures } from "@/lib/sandbox-fixtures";

// Get specific fixture
const walletFixture = getFixture("wallet-success");

// List all fixtures
const allFixtures = listFixtures();
```

### Fixture Categories

#### Wallet Fixtures
- `wallet-success`: Successfully connected Stellar wallet
- `wallet-not-found`: Wallet connection failure

#### Transaction Fixtures
- `txn-success`: Successful payment transaction
- `txn-insufficient`: Insufficient balance error
- `txn-timeout`: Network timeout error

#### Verification Fixtures
- `verify-success`: Verification approved
- `verify-declined`: Verification declined

## API

### SandboxManager

```typescript
import { sandboxManager } from "@/lib/sandbox";

// Initialize sandbox
sandboxManager.initialize({ enabled: true });

// Check status
if (sandboxManager.isEnabled()) {
  // Sandbox is active
}

// Use mock services
if (sandboxManager.shouldMockServices()) {
  // Use MockStellarAdapter, MockVerificationAdapter, etc.
}
```

### Mock Adapters

All mock adapters return deterministic responses:

```typescript
import {
  MockStellarAdapter,
  MockVerificationAdapter,
  MockIPFSAdapter,
} from "@/lib/sandbox-adapters";

// Stellar operations
const balance = await MockStellarAdapter.getBalance(publicKey);
const txn = await MockStellarAdapter.submitTransaction(txn);

// Verification operations
const verified = await MockVerificationAdapter.verify(data);

// IPFS operations
const upload = await MockIPFSAdapter.upload(data);
```

## Testing

Run tests to verify sandbox behavior:

```bash
npm run test features/sandbox
```

Tests cover:
- Sandbox configuration
- Service adapter determinism
- Fixture availability
- Production credential exclusion

## Mock wallet balance generator

Build a wallet state (asset codes, issuers, balances) and inject it into components
without spending testnet tokens.

```typescript
import { sandboxManager } from "@/lib/sandbox";
import { buildMockWallet, buildWalletFromPreset } from "@/lib/sandbox-wallet";

// Inject a wallet built from an explicit draft
const wallet = buildMockWallet({
  label: "QA account",
  balances: [
    { asset: "native", balance: "12.5" },
    { asset: "USDC", issuer: "GBBD47IF…", balance: "250" },
  ],
});
sandboxManager.setWalletState(wallet);

sandboxManager.getWalletState(); // -> MockWalletState | null
sandboxManager.getInjectedBalances(); // -> MockBalance[]
sandboxManager.clearWalletState();

// Or start from a preset
sandboxManager.setWalletState(buildWalletFromPreset("low-xlm"));
```

`MockWalletState` carries `balances`, `reserve` (`subentryCount`, `baseReserve`,
`minimumReserve`, `spendable`, `belowMinimum`) and `warnings`. Each `MockBalance`
carries a normalised `balance` (7 decimal places), `balanceStroops`, `limit`,
`authorized`, `sponsored` and `hasTrustline`, so a component can render a
low-balance or unauthorised-trustline state on demand.

Presets: `healthy`, `low-xlm`, `no-trustlines`, `unauthorised`, `empty`.

`validateDraft(balances)` returns `{ ok: false, error }` for an invalid draft
(bad asset code, malformed issuer, unparseable amount) instead of throwing, so the
generator UI can show a message per row.

The UI lives in `features/sandbox/components/WalletBalanceGenerator.tsx`
(`useSandboxWallet()` for the draft rows and validation messages).

## Scenario presets

`lib/sandbox-scenarios.ts` models the on-chain failure modes that are awkward to
reproduce: `out_of_energy`, `invalid_sequence` (`txBAD_SEQ`), `tx_expired`
(`txTOO_LATE`), `insufficient_balance`, `missing_trustline`, `unauthorised_asset`,
`contract_trap`, `invalid_argument`, `rate_limited`, `timeout` — plus `success`
(`txSUCCESS`).

```typescript
import { isRetriableScenario } from "@/lib/sandbox-scenarios";
import { scenarioToResponse } from "@/lib/sandbox-replay"; // or "@/..." path

sandboxManager.setActiveScenario("out_of_energy"); // mock adapters now fail this way
const response = scenarioToResponse("invalid_sequence");
isRetriableScenario("tx_expired"); // true (txBAD_SEQ / txTOO_LATE are replayable)
```

Select one in the UI with `features/sandbox/components/ScenarioPresetSelector.tsx`.

## Transaction recorder and replay

```typescript
import { ScenarioRecorder, TransactionReplayAdapter } from "@/lib/sandbox-replay";

const recorder = new ScenarioRecorder({ name: "payment flow" }).start();
await recorder.capture("submitTransaction", request, () => stellar.submit(request));

const tape = recorder.toTape();
const replay = new TransactionReplayAdapter(tape, { strategy: "first-match" });
await replay.replay("submitTransaction", request); // -> the recorded SandboxResponse
```

Replayable methods: `getBalance`, `getBalances`, `simulateTransaction`,
`submitTransaction`, `getTransactionStatus`. Strategies: `first-match`,
`sequence`, `last-match`, `round-robin`, with `matchRequest`, `latencyMs`,
`jitterMs`, `onExhausted` (`"error"` or `"last"`) and a `seed` for reproducible
jitter. `replaySync()` skips simulated latency.

Tapes round-trip as JSON (`recorder.toJSON()`, `parseTape()`, `recorder.load()`)
and `buildTapeFromScenarios()` / `buildTapeFromPreset("edge-cases")` produce a
ready-made tape for a scenario.

The UI lives in `features/sandbox/components/TransactionScenarioRecorder.tsx`
(`useScenarioRecorder()` for tapes, replay runs and history).

## Sandbox panel

`features/sandbox/components/SandboxPanel.tsx` combines the snapshot banner, mode
switcher, wallet generator, preset selector and recorder in one drop-in component:

```tsx
import { SandboxPanel } from "@/features/sandbox/components/SandboxPanel";

<SandboxPanel />;
```
