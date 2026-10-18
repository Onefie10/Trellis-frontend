/**
 * APDU client for the Ledger Stellar app.
 *
 * Two implementations are provided:
 *
 *  - `VendorStrApp` wraps `@ledgerhq/hw-app-str`, which is the reference client
 *    shipped by LedgerHQ.
 *  - `ApduStrApp` speaks the same protocol directly (`CLA = 0xe0`), mirroring the
 *    framing used by the vendor package: a first APDU with `P1 = 0x00` followed by
 *    continuation APDUs with `P1 = 0x80`, and `P2 = 0x80` while more data follows.
 *
 * The APDU client is used when the vendor package cannot be loaded (for example in
 * a browser bundle that has no `Buffer` polyfill, which `bip32-path` needs), so
 * hardware signing keeps working either way.
 *
 * Instructions implemented (matching `@ledgerhq/hw-app-str`):
 *   GET_PUBLIC_KEY              0x02
 *   SIGN_TRANSACTION            0x04
 *   GET_APP_CONFIGURATION       0x06
 *   SIGN_HASH                   0x08
 *   SIGN_SOROBAN_AUTHORIZATION  0x0a
 */

import { pathToBytes } from "./bip32";
import { LedgerError, ledgerErrorFromStatus, normalizeLedgerError } from "./errors";
import { parseLedgerSignature, toUint8Array } from "./signature";
import type { LedgerTransport } from "./transport";

export const LEDGER_CLA = 0xe0;

export const LEDGER_INS = {
  GET_PUBLIC_KEY: 0x02,
  SIGN_TRANSACTION: 0x04,
  GET_APP_CONFIGURATION: 0x06,
  SIGN_HASH: 0x08,
  SIGN_SOROBAN_AUTHORIZATION: 0x0a,
} as const;

export const LEDGER_P1 = {
  FIRST: 0x00,
  MORE: 0x80,
} as const;

export const LEDGER_P2 = {
  LAST: 0x00,
  MORE: 0x80,
} as const;

/** The Stellar app accepts at most 255 bytes of payload per APDU. */
export const LEDGER_APDU_PAYLOAD_SIZE = 255;

export const SW_OK = 0x9000;

export interface LedgerAppConfiguration {
  version: string;
  hashSigningEnabled: boolean;
  maxDataSize: number;
}

export interface LedgerStrApp {
  /** Identifier used in logs/telemetry. */
  readonly kind: string;
  getAppConfiguration(): Promise<LedgerAppConfiguration>;
  /** Returns the raw 32-byte Ed25519 public key. */
  getPublicKey(derivationPath: string, options?: { display?: boolean }): Promise<Uint8Array>;
  /** Signs a transaction signature base and returns the raw 64-byte signature. */
  signTransaction(derivationPath: string, signatureBase: Uint8Array): Promise<Uint8Array>;
  /** Signs a Soroban authorization hash-id preimage. */
  signSorobanAuthorization(derivationPath: string, preimage: Uint8Array): Promise<Uint8Array>;
  /** Signs a 32-byte payload hash (requires hash signing to be enabled). */
  signHash(derivationPath: string, hash: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Split a response into payload + status word, throwing a typed `LedgerError` when
 * the device answered with something other than `0x9000`.
 */
export function stripStatus(response: Uint8Array): Uint8Array {
  if (response.length < 2) {
    throw new LedgerError("Truncated response from the Ledger device", {
      code: "invalid-response",
    });
  }

  const status = (response[response.length - 2] << 8) | response[response.length - 1];
  if (status !== SW_OK) {
    throw ledgerErrorFromStatus(status, { app: true });
  }

  return response.subarray(0, response.length - 2);
}

/** Direct APDU implementation of the Ledger Stellar app protocol. */
export class ApduStrApp implements LedgerStrApp {
  readonly kind = "apdu";

  constructor(private readonly transport: LedgerTransport) {}

  async getAppConfiguration(): Promise<LedgerAppConfiguration> {
    const data = stripStatus(
      await this.send(LEDGER_INS.GET_APP_CONFIGURATION, LEDGER_P1.FIRST, LEDGER_P2.LAST),
    );
    if (data.length < 4) {
      throw new LedgerError("Your Ledger returned a malformed app configuration", {
        code: "invalid-response",
      });
    }

    const [hashSigningEnabled, major, minor, patch] = data;
    return {
      version: `${major}.${minor}.${patch}`,
      hashSigningEnabled: hashSigningEnabled === 1,
      maxDataSize: data.length >= 6 ? (data[4] << 8) | data[5] : 0,
    };
  }

  async getPublicKey(
    derivationPath: string,
    options: { display?: boolean } = {},
  ): Promise<Uint8Array> {
    const data = stripStatus(
      await this.send(
        LEDGER_INS.GET_PUBLIC_KEY,
        LEDGER_P1.FIRST,
        options.display ? 0x01 : 0x00,
        pathToBytes(derivationPath),
      ),
    );
    return toUint8Array(data, "public key");
  }

  async signTransaction(derivationPath: string, signatureBase: Uint8Array): Promise<Uint8Array> {
    const payload = concat(pathToBytes(derivationPath), toUint8Array(signatureBase, "signature base"));
    return parseLedgerSignature(await this.sendChunked(LEDGER_INS.SIGN_TRANSACTION, payload));
  }

  async signSorobanAuthorization(
    derivationPath: string,
    preimage: Uint8Array,
  ): Promise<Uint8Array> {
    const payload = concat(pathToBytes(derivationPath), toUint8Array(preimage, "soroban preimage"));
    return parseLedgerSignature(
      await this.sendChunked(LEDGER_INS.SIGN_SOROBAN_AUTHORIZATION, payload),
    );
  }

  async signHash(derivationPath: string, hash: Uint8Array): Promise<Uint8Array> {
    const payload = concat(pathToBytes(derivationPath), toUint8Array(hash, "payload hash"));
    return parseLedgerSignature(await this.sendChunked(LEDGER_INS.SIGN_HASH, payload));
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private async send(
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
  ): Promise<Uint8Array> {
    try {
      return await this.transport.send(LEDGER_CLA, ins, p1, p2, data);
    } catch (error) {
      throw normalizeLedgerError(error, "transport");
    }
  }

  private async sendChunked(ins: number, payload: Uint8Array): Promise<Uint8Array> {
    let offset = 0;
    let remaining = payload.length;
    let response: Uint8Array = new Uint8Array(0);

    do {
      const chunkSize = Math.min(LEDGER_APDU_PAYLOAD_SIZE, remaining);
      const chunk = payload.subarray(offset, offset + chunkSize);
      const isFirst = offset === 0;
      const isLast = remaining - chunkSize === 0;

      response = await this.send(
        ins,
        isFirst ? LEDGER_P1.FIRST : LEDGER_P1.MORE,
        isLast ? LEDGER_P2.LAST : LEDGER_P2.MORE,
        chunk,
      );

      offset += chunkSize;
      remaining -= chunkSize;
    } while (remaining > 0);

    return stripStatus(response);
  }
}

type VendorStrAppInstance = {
  getAppConfiguration?: () => Promise<{
    version?: string;
    hashSigningEnabled?: boolean;
    maxDataSize?: number;
  }>;
  getPublicKey?: (
    path: string,
    display?: boolean,
  ) => Promise<{ rawPublicKey?: unknown } | unknown>;
  signTransaction?: (
    path: string,
    transaction: unknown,
  ) => Promise<{ signature?: unknown } | unknown>;
  signSorobanAuthorization?: (path: string, data: unknown) => Promise<unknown>;
  signHash?: (path: string, hash: unknown) => Promise<unknown>;
};

type VendorStrAppConstructor = new (
  transport: LedgerTransport,
  scrambleKey?: string,
) => VendorStrAppInstance;

/** Thin adapter over `@ledgerhq/hw-app-str`. */
export class VendorStrApp implements LedgerStrApp {
  readonly kind = "hw-app-str";

  constructor(
    private readonly app: VendorStrAppInstance,
    private readonly onClose: () => Promise<void>,
  ) {}

  async getAppConfiguration(): Promise<LedgerAppConfiguration> {
    if (typeof this.app.getAppConfiguration !== "function") {
      throw new LedgerError("This Stellar app build does not report its configuration", {
        code: "unavailable",
      });
    }

    const config = await this.app.getAppConfiguration();
    return {
      version: config?.version ?? "unknown",
      hashSigningEnabled: Boolean(config?.hashSigningEnabled),
      maxDataSize: Number(config?.maxDataSize ?? 0),
    };
  }

  async getPublicKey(
    derivationPath: string,
    options: { display?: boolean } = {},
  ): Promise<Uint8Array> {
    if (typeof this.app.getPublicKey !== "function") {
      throw new LedgerError("This Stellar app build cannot export public keys", {
        code: "unavailable",
      });
    }

    try {
      const result = await this.app.getPublicKey(derivationPath, Boolean(options.display));
      const raw =
        result && typeof result === "object" && "rawPublicKey" in result
          ? (result as { rawPublicKey?: unknown }).rawPublicKey
          : result;
      return toUint8Array(raw, "public key");
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-response");
    }
  }

  async signTransaction(derivationPath: string, signatureBase: Uint8Array): Promise<Uint8Array> {
    if (typeof this.app.signTransaction !== "function") {
      throw new LedgerError("This Stellar app build cannot sign transactions", {
        code: "unavailable",
      });
    }

    try {
      const result = await this.app.signTransaction(derivationPath, toBufferLike(signatureBase));
      return parseLedgerSignature(result);
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-signature");
    }
  }

  async signSorobanAuthorization(
    derivationPath: string,
    preimage: Uint8Array,
  ): Promise<Uint8Array> {
    if (typeof this.app.signSorobanAuthorization !== "function") {
      throw new LedgerError(
        "This Stellar app build cannot sign Soroban authorizations. Update the Stellar app on your Ledger.",
        { code: "unavailable" },
      );
    }

    try {
      const result = await this.app.signSorobanAuthorization(
        derivationPath,
        toBufferLike(preimage),
      );
      return parseLedgerSignature(result);
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-signature");
    }
  }

  async signHash(derivationPath: string, hash: Uint8Array): Promise<Uint8Array> {
    if (typeof this.app.signHash !== "function") {
      throw new LedgerError(
        "This Stellar app build cannot sign raw hashes. Update the Stellar app on your Ledger.",
        { code: "unavailable" },
      );
    }

    try {
      const result = await this.app.signHash(derivationPath, toBufferLike(hash));
      return parseLedgerSignature(result);
    } catch (error) {
      throw normalizeLedgerError(error, "invalid-signature");
    }
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}

export interface CreateStrAppOptions {
  /**
   * Prefer `@ledgerhq/hw-app-str` when it can be loaded. Defaults to `true`.
   */
  preferVendorApp?: boolean;
  /** Test seam: build the app client for a transport. */
  strAppFactory?: (transport: LedgerTransport) => LedgerStrApp | Promise<LedgerStrApp>;
}

/**
 * Build the best available Stellar app client for a connected transport.
 *
 * The vendor package is used when it loads; otherwise the built-in APDU client
 * takes over. `bip32-path` (a dependency of the vendor package) needs a global
 * `Buffer`, which Next.js only provides when it is polyfilled, so the fallback is
 * the common path in the browser.
 */
export async function createLedgerStrApp(
  transport: LedgerTransport,
  options: CreateStrAppOptions = {},
): Promise<LedgerStrApp> {
  const { preferVendorApp = true, strAppFactory } = options;
  if (strAppFactory) return strAppFactory(transport);

  if (preferVendorApp && hasBuffer()) {
    const VendorApp = await loadVendorStrApp();
    if (VendorApp) {
      try {
        return new VendorStrApp(new VendorApp(transport), () => transport.close());
      } catch {
        // Fall through to the APDU client below.
      }
    }
  }

  return new ApduStrApp(transport);
}

async function loadVendorStrApp(): Promise<VendorStrAppConstructor | null> {
  try {
    const ledgerModule = (await import("@ledgerhq/hw-app-str")) as {
      default?: unknown;
      Str?: unknown;
    };
    const candidate = (ledgerModule.default ?? ledgerModule.Str) as VendorStrAppConstructor | undefined;
    return typeof candidate === "function" ? candidate : null;
  } catch {
    return null;
  }
}

function hasBuffer(): boolean {
  const globalBuffer = (globalThis as { Buffer?: { from?: unknown } }).Buffer;
  return Boolean(globalBuffer && typeof globalBuffer.from === "function");
}

/**
 * `@ledgerhq/hw-app-str` concatenates payloads with `Buffer.concat`, which only
 * accepts Buffer-like values, so wrap the array when a Buffer implementation is
 * available and pass the raw bytes through otherwise.
 */
function toBufferLike(bytes: Uint8Array): Uint8Array {
  const globalBuffer = (globalThis as { Buffer?: { from?: (input: Uint8Array) => Uint8Array } })
    .Buffer;
  if (globalBuffer && typeof globalBuffer.from === "function") {
    return globalBuffer.from(bytes);
  }
  return bytes;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}
