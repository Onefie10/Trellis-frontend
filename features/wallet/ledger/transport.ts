/**
 * WebHID transport plumbing for Ledger devices.
 *
 * `@ledgerhq/hw-transport-webhid` is loaded lazily so the Ledger packages never
 * enter the main bundle (and so the wallet UI keeps working in browsers without
 * WebHID, where the import would throw).
 */

import { LedgerError, ledgerErrorMessage, normalizeLedgerError } from "./errors";
import { toUint8Array } from "./signature";

/** The subset of the Ledger transport API the adapter relies on. */
export interface LedgerTransport {
  send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
  /** Present on Ledger transports; `hw-app-str` calls it in its constructor. */
  decorateAppAPIMethods?(
    self: unknown,
    methods: string[],
    scrambleKey: string,
  ): void;
}

export type LedgerTransportFactory = () => Promise<unknown>;

export interface LedgerTransportOptions {
  /** Test seam: return a transport (or transport-like object) to wrap. */
  transportFactory?: LedgerTransportFactory;
}

/**
 * True when the current browsing context can open Ledger devices over WebHID.
 */
export function isWebHidSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  const hid = (navigator as Navigator & { hid?: { requestDevice?: unknown } }).hid;
  if (!hid || typeof hid.requestDevice !== "function") return false;

  const secureContext = (globalThis as { isSecureContext?: boolean }).isSecureContext;
  // WebHID is only exposed in secure contexts; `undefined` means we cannot tell
  // (jsdom, older runtimes), so fall back to the presence check above.
  return secureContext === undefined ? true : secureContext;
}

/**
 * Wrap a Ledger transport into the small interface this integration uses, and
 * validate that it actually implements it.
 */
export function wrapTransport(raw: unknown): LedgerTransport {
  const candidate = raw as
    | {
        send?: (...args: unknown[]) => Promise<unknown>;
        close?: () => unknown;
        decorateAppAPIMethods?: (...args: unknown[]) => void;
      }
    | null
    | undefined;

  if (!candidate || typeof candidate.send !== "function") {
    throw new LedgerError("The WebHID transport did not expose a send() method", {
      code: "unavailable",
    });
  }

  const send = candidate.send.bind(candidate);
  const close = candidate.close?.bind(candidate);
  const decorate = candidate.decorateAppAPIMethods?.bind(candidate);

  return {
    async send(cla, ins, p1, p2, data) {
      const response = await send(cla, ins, p1, p2, data ? toUint8Array(data) : undefined);
      return toUint8Array(response, "transport response");
    },
    async close() {
      if (close) await close();
    },
    decorateAppAPIMethods(self, methods, scrambleKey) {
      if (decorate) decorate(self, methods, scrambleKey);
    },
  };
}

/**
 * Open a WebHID connection to a Ledger device.
 *
 * The browser shows its own device chooser, so this must be called from a user
 * gesture (a click) for the prompt to appear.
 */
export async function createLedgerTransport(
  options: LedgerTransportOptions = {},
): Promise<LedgerTransport> {
  const { transportFactory } = options;

  try {
    if (transportFactory) {
      return wrapTransport(await transportFactory());
    }

    if (!isWebHidSupported()) {
      throw new LedgerError(ledgerErrorMessage("unsupported"), { code: "unsupported" });
    }

    const hidModule = (await import("@ledgerhq/hw-transport-webhid")) as {
      default?: unknown;
      create?: unknown;
    };
    const TransportWebHID = (hidModule.default ?? hidModule) as { create?: () => Promise<unknown> };
    if (!TransportWebHID || typeof TransportWebHID.create !== "function") {
      throw new LedgerError(ledgerErrorMessage("unavailable"), { code: "unavailable" });
    }

    return wrapTransport(await TransportWebHID.create());
  } catch (error) {
    throw normalizeLedgerError(error, "unavailable");
  }
}
