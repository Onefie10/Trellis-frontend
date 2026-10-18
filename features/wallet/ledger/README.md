# Ledger hardware wallet integration

WebHID integration with the Ledger Stellar app for signing Stellar / Soroban
transactions with a key that never leaves the device.

```
features/wallet/ledger/
├── adapter.ts        LedgerWalletAdapter + module-level session helpers
├── transport.ts      lazy WebHID transport creation
├── str-app.ts        Stellar app client (hw-app-str, plus a built-in APDU client)
├── bip32.ts          m/44'/148'/index' path parsing + APDU serialisation
├── signature.ts      signature/public-key payload parsing, hints, hex helpers
├── strkey.ts         Ed25519 StrKey (`G...`) encode/decode
├── errors.ts         typed errors, status words, user-facing messages
└── prompt-guide.ts   the device walkthrough copy used by the connect dialog
```

## Usage

```ts
import { connectLedgerWallet, disconnectLedger, signWithLedger } from "@/features/wallet/ledger";

// Must be called from a user gesture: the browser shows its own device chooser.
const adapter = await connectLedgerWallet();            // default path 44'/148'/0'
const account = await adapter.getAccount({ display: true }); // user verifies on the device
console.log(account.address, account.derivationPath);

// Sign a transaction (anything exposing `signatureBase()` works).
const { signature, hint } = await adapter.signTransaction(transaction);
transaction.signatures.push(
  new StellarSdk.xdr.DecoratedSignature({
    hint: Buffer.from(hint),
    signature: Buffer.from(signature),
  }),
);

await disconnectLedger(); // release the device
```

- `adapter.signSignatureBase(bytes)` signs a raw signature base.
- `adapter.signSorobanAuthorization(preimage)` signs a Soroban authorization
  hash-id preimage.
- `adapter.signHash(hash)` signs a 32-byte payload hash (the Stellar app must have
  *Hash signing* enabled in its settings).
- `signWithLedger(transaction)` is the shorthand used by `lib/stellar.ts`'s
  `signTransactionWithLedger`; it reuses the open session when there is one.

## Error handling

Every failure is normalised to a `LedgerError` with a `code`, an optional APDU
`statusCode`, and a user-facing message. `ledgerErrorHint(code)` returns the
actionable next step, `toUserMessage(error)` returns just the message, and
`isUserRejection(error)` detects a refused/dismissed prompt.

| Status word | Code                    | Meaning                                    |
| ----------- | ----------------------- | ------------------------------------------ |
| `0x9000`    | –                       | success                                    |
| `0x6985`    | `user-rejected`         | rejected on the device                     |
| `0x6d00`    | `app-not-open`          | the Stellar app is not open                |
| `0x6e00`    | `wrong-app`             | another app is in the foreground           |
| `0x5515`    | `locked`                | device locked                              |
| `0x6c66`    | `hash-signing-disabled` | hash signing disabled in the app settings  |
| `0xb004`    | `data-too-large`        | payload exceeds `maxDataSize`              |
| `0xb005`    | `invalid-data`          | the app could not parse the payload        |

DOM exceptions from the WebHID chooser are mapped as well: `NotAllowedError` and
`NotFoundError` become `no-device`, and `SecurityError` becomes `unavailable`
(typically a Permissions-Policy or insecure-context problem).

## Why there are two app clients

`VendorStrApp` wraps `@ledgerhq/hw-app-str`. That package serialises paths with
`bip32-path`, which needs a global `Buffer`, so it is only used when one is
available. Otherwise `ApduStrApp` talks to the device directly with the same
framing (`CLA = 0xe0`, first APDU with `P1 = 0x00`, continuation APDUs with
`P1 = 0x80`, `P2 = 0x80` while more data follows, 255-byte payloads), so signing
keeps working in a plain browser bundle. Both clients expose the same
`LedgerStrApp` interface, and `createLedgerStrApp` picks one.

## Tests

```bash
npx jest --config jest.config.cjs features/wallet/ledger
```

The suite covers path handling, StrKey encoding, signature payload parsing (raw,
hex, base64 and DER), APDU framing/chunking, status-word mapping, transport
wrapping and the adapter's connect/sign/disconnect flow using injected fakes.
