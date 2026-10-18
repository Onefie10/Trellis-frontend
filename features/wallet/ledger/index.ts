/**
 * Ledger hardware wallet support for Stellar / Soroban transactions.
 *
 * ```ts
 * import { connectLedgerWallet, disconnectLedger } from "@/features/wallet/ledger";
 *
 * const adapter = await connectLedgerWallet();
 * const account = await adapter.getAccount({ display: true }); // verify on device
 * const { signature, hintHex } = await adapter.signTransaction(transaction);
 * await disconnectLedger();
 * ```
 */

export * from "./bip32";
export * from "./strkey";
export * from "./errors";
export * from "./signature";
export * from "./prompt-guide";
export * from "./str-app";
export * from "./transport";
export * from "./adapter";
