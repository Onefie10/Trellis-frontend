/**
 * Ledger hardware wallet adapter.
 *
 * Connect over WebHID, derive the Stellar account at `m/44'/148'/0'`, and sign
 * transaction signature bases (or Soroban authorization preimages) on the device.
 *
 * The adapter is framework agnostic: it only needs a `signatureBase()` method on
 * the transaction object, which keeps it usable from plain `@stellar/stellar-sdk`
 * code as well as from the React providers in this app.
 */

import { STELLAR_DERIVATION_PATH, assertStellarBip32Path } from "./bip32";
import { LedgerError, normalizeLedgerError } from "./errors";
import {
  accountFromPublicKey,
  bytesToHex,
  signatureHintOf,
  toUint8Array,
  type LedgerAccount,
} from "./signature";
import {
  createLedgerStrApp,
  type LedgerAppConfiguration,
  type LedgerStrApp,
} from "./str-app";
import {
  createLedgerTransport,
  type LedgerTransport,
  type LedgerTransportFactory,
} from "./transport";

/** Minimal shape of a signable Stellar transaction. */
export interface LedgerSignableTransaction {
  /**
   * The payload the Ledger Stellar app signs: `Transaction.signatureBase()` in
   * `@stellar/stellar-sdk` (transaction XDR plus the network id).
   */
  signatureBase(): Uint8Array;
}

export interface LedgerSignatureResult {
  /** Raw 64-byte Ed25519 signature returned by the device. */
  signature: Uint8Array;
  signatureHex: string;
  /** 4-byte `DecoratedSignature` hint, i.e. the last 4 bytes of the public key. */
  hint: Uint8Array;
  hintHex: string;
  address: string;
  publicKey: string;
  derivationPath: string;
}

export interface LedgerWalletAdapterOptions {
  /** BIP-32 account path. Defaults to `44'/148'/0'`. */
  derivationPath?: string;
  /**
   * An already open transport (mostly for tests and reconnects). When a transport
   * is supplied the caller keeps ownership of closing it.
   */
  transport?: LedgerTransport;
  transportFactory?: LedgerTransportFactory;
  /** An already built Stellar app client. */
  strApp?: LedgerStrApp;
  strAppFactory?: (transport: LedgerTransport) => LedgerStrApp | Promise<LedgerStrApp>;
  /** Use `@ledgerhq/hw-app-str` when it is loadable. Defaults to `true`. */
  preferVendorApp?: boolean;
}

export class LedgerWalletAdapter {
  private readonly app: LedgerStrApp;
  private readonly transport: LedgerTransport;
  private readonly ownsTransport: boolean;
  private account: LedgerAccount | null = null;
  private connected = true;

  readonly derivationPath: string;

  private constructor(
    app: LedgerStrApp,
    transport: LedgerTransport,
    derivationPath: string,
    ownsTransport: boolean,
  ) {
    this.app = app;
    this.transport = transport;
    this.derivationPath = derivationPath;
    this.ownsTransport = ownsTransport;
  }

  /** Open a WebHID session, or reuse the transport/app clients passed in options. */
  static async connect(
    options: LedgerWalletAdapterOptions = {},
  ): Promise<LedgerWalletAdapter> {
    let derivationPath: string;
    try {
      derivationPath = assertStellarBip32Path(
        options.derivationPath ?? STELLAR_DERIVATION_PATH,
      );
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-path");
    }

    try {
      const transport =
        options.transport ??
        (await createLedgerTransport({ transportFactory: options.transportFactory }));

      const app =
        options.strApp ??
        (await createLedgerStrApp(transport, {
          preferVendorApp: options.preferVendorApp,
          strAppFactory: options.strAppFactory,
        }));

      return new LedgerWalletAdapter(app, transport, derivationPath, !options.transport);
    } catch (error) {
      throw normalizeLedgerError(error, "unavailable");
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get appKind(): string {
    return this.app.kind;
  }

  /**
   * Read the account public key. Pass `display: true` to make the device show the
   * address for the user to verify before it is trusted.
   */
  async getAccount(options: { display?: boolean } = {}): Promise<LedgerAccount> {
    if (this.account && !options.display) return this.account;

    this.assertConnected();
    try {
      const rawPublicKey = await this.app.getPublicKey(this.derivationPath, {
        display: Boolean(options.display),
      });
      const account = accountFromPublicKey(rawPublicKey, this.derivationPath);
      this.account = account;
      return account;
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-response");
    }
  }

  /** The `G...` address for this device and derivation path. */
  async getAddress(options: { display?: boolean } = {}): Promise<string> {
    const account = await this.getAccount(options);
    return account.address;
  }

  async getAppConfiguration(): Promise<LedgerAppConfiguration> {
    this.assertConnected();
    try {
      return await this.app.getAppConfiguration();
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-response");
    }
  }

  /** Sign a transaction signature base (`Transaction.signatureBase()`). */
  async signTransaction(transaction: LedgerSignableTransaction): Promise<LedgerSignatureResult> {
    if (!transaction || typeof transaction.signatureBase !== "function") {
      throw new LedgerError(
        "The transaction passed to Ledger does not expose signatureBase()",
        { code: "invalid-data" },
      );
    }

    return this.signSignatureBase(toUint8Array(transaction.signatureBase(), "signature base"));
  }

  /** Sign a raw signature base payload with the configured derivation path. */
  async signSignatureBase(signatureBase: Uint8Array): Promise<LedgerSignatureResult> {
    this.assertConnected();
    try {
      const account = await this.getAccount();
      const signature = await this.app.signTransaction(this.derivationPath, signatureBase);
      return this.buildResult(signature, account);
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-signature");
    }
  }

  /** Sign a Soroban authorization hash-id preimage. */
  async signSorobanAuthorization(preimage: Uint8Array): Promise<LedgerSignatureResult> {
    this.assertConnected();
    try {
      const account = await this.getAccount();
      const signature = await this.app.signSorobanAuthorization(
        this.derivationPath,
        toUint8Array(preimage, "soroban preimage"),
      );
      return this.buildResult(signature, account);
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-signature");
    }
  }

  /** Sign a 32-byte payload hash. Requires hash signing to be enabled on device. */
  async signHash(hash: Uint8Array): Promise<LedgerSignatureResult> {
    this.assertConnected();
    try {
      const account = await this.getAccount();
      const signature = await this.app.signHash(
        this.derivationPath,
        toUint8Array(hash, "payload hash"),
      );
      return this.buildResult(signature, account);
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-signature");
    }
  }

  /** Close the WebHID session and forget the cached account. */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.account = null;

    if (activeAdapter === this) activeAdapter = null;
    if (!this.ownsTransport && this.transport) {
      // A transport supplied by the caller stays under the caller's control.
      return;
    }

    try {
      await this.app.close();
    } catch {
      // Closing an already-closed device must not surface as an error.
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new LedgerError("Your Ledger is disconnected. Reconnect it and try again.", {
        code: "transport",
      });
    }
  }

  private buildResult(signature: Uint8Array, account: LedgerAccount): LedgerSignatureResult {
    const hint = signatureHintOf(account);
    return {
      signature,
      signatureHex: bytesToHex(signature),
      hint,
      hintHex: bytesToHex(hint),
      address: account.address,
      publicKey: account.publicKey,
      derivationPath: this.derivationPath,
    };
  }
}

let activeAdapter: LedgerWalletAdapter | null = null;

/** The adapter currently holding the WebHID session, if any. */
export function getActiveLedgerAdapter(): LedgerWalletAdapter | null {
  return activeAdapter;
}

export function isLedgerConnected(): boolean {
  return Boolean(activeAdapter?.isConnected);
}

/** Test seam: publish (or clear) the module level adapter. */
export function setActiveLedgerAdapter(adapter: LedgerWalletAdapter | null): void {
  activeAdapter = adapter;
}

/**
 * Connect a Ledger, reusing the open session when there is one so the device does
 * not prompt twice.
 */
export async function connectLedgerWallet(
  options: LedgerWalletAdapterOptions & { force?: boolean } = {},
): Promise<LedgerWalletAdapter> {
  const { force = false, ...adapterOptions } = options;

  if (!force && activeAdapter?.isConnected) return activeAdapter;
  if (activeAdapter) {
    await activeAdapter.disconnect().catch(() => undefined);
    activeAdapter = null;
  }

  const adapter = await LedgerWalletAdapter.connect(adapterOptions);
  activeAdapter = adapter;
  return adapter;
}

/** Close the active Ledger session, if any. */
export async function disconnectLedger(): Promise<void> {
  const adapter = activeAdapter;
  activeAdapter = null;
  if (adapter) await adapter.disconnect();
}

/** Sign a transaction with the active Ledger, connecting first when needed. */
export async function signWithLedger(
  transaction: LedgerSignableTransaction,
  options: LedgerWalletAdapterOptions & { force?: boolean } = {},
): Promise<LedgerSignatureResult> {
  const adapter = await connectLedgerWallet(options);
  return adapter.signTransaction(transaction);
}
