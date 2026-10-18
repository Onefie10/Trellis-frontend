/**
 * Typed errors for the Ledger hardware wallet integration.
 *
 * Ledger transports surface failures in three different shapes:
 *   1. a numeric APDU status word (`0x6985` for a user rejection, ...),
 *   2. a DOM exception raised by the WebHID chooser (`NotAllowedError`, ...),
 *   3. a plain `Error` with a human readable message.
 *
 * Everything is normalised into a `LedgerError` so the UI can render a single,
 * actionable instruction instead of a raw stack trace.
 */

export type LedgerErrorCode =
  | "unsupported"
  | "unavailable"
  | "no-device"
  | "locked"
  | "app-not-open"
  | "wrong-app"
  | "user-rejected"
  | "hash-signing-disabled"
  | "data-too-large"
  | "invalid-data"
  | "invalid-path"
  | "invalid-signature"
  | "invalid-response"
  | "transport"
  | "unknown";

export interface LedgerErrorOptions {
  code?: LedgerErrorCode;
  statusCode?: number | null;
  cause?: unknown;
}

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly statusCode: number | null;

  constructor(message: string, options: LedgerErrorOptions = {}) {
    super(message);
    this.name = "LedgerError";
    this.code = options.code ?? "unknown";
    this.statusCode = options.statusCode ?? null;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isLedgerError(error: unknown): error is LedgerError {
  return error instanceof LedgerError;
}

/** APDU status words returned by the Ledger Stellar app. */
export const LEDGER_STATUS_WORDS = {
  OK: 0x9000,
  DENY: 0x6985,
  APP_NOT_OPEN: 0x6d00,
  WRONG_APP: 0x6e00,
  LOCKED: 0x5515,
  DATA_TOO_LARGE: 0xb004,
  DATA_PARSING_FAILED: 0xb005,
  HASH_SIGNING_DISABLED: 0x6c66,
  INVALID_P1_P2: 0x6b00,
  WRONG_DATA_LENGTH: 0x6a87,
  INVALID_DATA: 0x6a80,
} as const;

const STATUS_WORD_CODES: Record<number, LedgerErrorCode> = {
  [LEDGER_STATUS_WORDS.DENY]: "user-rejected",
  [LEDGER_STATUS_WORDS.APP_NOT_OPEN]: "app-not-open",
  [LEDGER_STATUS_WORDS.WRONG_APP]: "wrong-app",
  [LEDGER_STATUS_WORDS.LOCKED]: "locked",
  [LEDGER_STATUS_WORDS.DATA_TOO_LARGE]: "data-too-large",
  [LEDGER_STATUS_WORDS.DATA_PARSING_FAILED]: "invalid-data",
  [LEDGER_STATUS_WORDS.HASH_SIGNING_DISABLED]: "hash-signing-disabled",
  [LEDGER_STATUS_WORDS.INVALID_P1_P2]: "invalid-path",
  [LEDGER_STATUS_WORDS.WRONG_DATA_LENGTH]: "invalid-data",
  [LEDGER_STATUS_WORDS.INVALID_DATA]: "invalid-data",
};

const ERROR_MESSAGES: Record<LedgerErrorCode, string> = {
  unsupported: "This browser cannot talk to a Ledger device. WebHID needs Chrome, Edge, Brave or Opera.",
  unavailable: "Ledger support could not be loaded. Reload the page and try again.",
  "no-device": "No Ledger device was selected. Plug the device in and pick it from the browser prompt.",
  locked: "Your Ledger is locked. Unlock it with your PIN and try again.",
  "app-not-open": "Open the Stellar app on your Ledger, then try again.",
  "wrong-app": "A different app is open on your Ledger. Close it and open the Stellar app.",
  "user-rejected": "The request was rejected on your Ledger device.",
  "hash-signing-disabled":
    "Hash signing is disabled on your Ledger. Enable Stellar app settings -> Hash signing before signing this payload.",
  "data-too-large": "The transaction is too large for the Ledger Stellar app in one request.",
  "invalid-data": "Your Ledger could not parse the payload. Update the Stellar app on the device.",
  "invalid-path": "The derivation path was rejected by your Ledger device.",
  "invalid-signature": "Your Ledger returned a signature the app could not decode.",
  "invalid-response": "Your Ledger returned an unexpected response.",
  transport: "The connection to your Ledger was interrupted. Reconnect the device and try again.",
  unknown: "Something went wrong while talking to your Ledger device.",
};

const ERROR_HINTS: Record<LedgerErrorCode, string> = {
  unsupported: "Use a Chromium-based browser over HTTPS (or localhost) to reach Ledger devices over WebHID.",
  unavailable: "Make sure no other tab or desktop app (Ledger Live) is holding the device.",
  "no-device": "Connect the Ledger with its USB cable, unlock it, then choose it in the browser prompt.",
  locked: "Unlock the device with your PIN, open the Stellar app, then retry.",
  "app-not-open": "On the device: open the Stellar app and leave it on screen.",
  "wrong-app": "On the device: press both buttons on the current app, then open Stellar.",
  "user-rejected": "Review the address / transaction on the device screen and approve it to continue.",
  "hash-signing-disabled": "On the device: Stellar app -> Settings -> Hash signing -> Allowed.",
  "data-too-large": "Split the operation or sign a smaller transaction.",
  "invalid-data": "Update the Stellar app to the latest version from Ledger Live.",
  "invalid-path": "Use a Stellar account path such as 44'/148'/0'.",
  "invalid-signature": "Retry the signature. If it keeps failing, update the Stellar app.",
  "invalid-response": "Reconnect the device and try again.",
  transport: "Unplug and replug the USB cable, then reconnect.",
  unknown: "Reconnect the device and try again.",
};

export function ledgerErrorMessage(code: LedgerErrorCode): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.unknown;
}

export function ledgerErrorHint(code: LedgerErrorCode): string {
  return ERROR_HINTS[code] ?? ERROR_HINTS.unknown;
}

export function ledgerErrorCodeForStatus(status: number): LedgerErrorCode {
  return STATUS_WORD_CODES[status & 0xffff] ?? "unknown";
}

/**
 * Build a `LedgerError` from a raw APDU status word, i.e. the two bytes returned
 * after the response payload.
 */
export function ledgerErrorFromStatus(
  status: number,
  context?: { app?: boolean },
): LedgerError {
  const code = ledgerErrorCodeForStatus(status);
  const suffix = status.toString(16).padStart(4, "0");
  const message =
    code === "unknown"
      ? `${ledgerErrorMessage(code)} (status 0x${suffix})`
      : `${ledgerErrorMessage(code)}${context?.app ? " (Stellar app)" : ""} (status 0x${suffix})`;
  return new LedgerError(message, { code, statusCode: status & 0xffff });
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}

function nameOf(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    return String((error as { name?: unknown }).name ?? "");
  }
  return "";
}

/**
 * Extract an APDU status word from a transport error. Ledger transports expose it
 * as `statusCode`/`status`, and also embed `(0x6985)` in the message.
 */
export function statusCodeOf(error: unknown): number | null {
  if (error && typeof error === "object") {
    const raw = (error as { statusCode?: unknown; status?: unknown }).statusCode ??
      (error as { status?: unknown }).status;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw & 0xffff;
    if (typeof raw === "string") {
      const parsed = /^0x([0-9a-f]{1,4})$/i.test(raw)
        ? parseInt(raw, 16)
        : /^\d+$/.test(raw)
          ? Number(raw)
          : null;
      if (parsed !== null) return parsed & 0xffff;
    }
  }

  const match = /0x([0-9a-f]{4})\b/i.exec(messageOf(error));
  return match ? parseInt(match[1], 16) & 0xffff : null;
}

/**
 * Normalise any thrown value into a `LedgerError`, preserving details when it
 * already is one.
 */
export function normalizeLedgerError(
  error: unknown,
  fallbackCode: LedgerErrorCode = "unknown",
): LedgerError {
  if (isLedgerError(error)) return error;

  const status = statusCodeOf(error);
  if (status !== null && status !== LEDGER_STATUS_WORDS.OK) {
    return ledgerErrorFromStatus(status);
  }

  const name = nameOf(error);
  const message = messageOf(error);

  if (name === "NotAllowedError" || name === "NotFoundError") {
    return new LedgerError(ledgerErrorMessage("no-device"), {
      code: "no-device",
      cause: error,
    });
  }
  if (name === "SecurityError") {
    return new LedgerError(
      "WebHID access was blocked for this page. Allow hardware device access and reload.",
      { code: "unavailable", cause: error },
    );
  }
  if (name === "NetworkError" || name === "InvalidStateError") {
    return new LedgerError(ledgerErrorMessage("transport"), {
      code: "transport",
      cause: error,
    });
  }

  const code: LedgerErrorCode = /user refused|refused|denied|rejected|cancel/i.test(message)
    ? "user-rejected"
    : /no device|device not found|disconnected/i.test(message)
      ? "no-device"
      : /locked/i.test(message)
        ? "locked"
        : /hash signing/i.test(message)
          ? "hash-signing-disabled"
          : /too large/i.test(message)
            ? "data-too-large"
            : /parse|malformed/i.test(message)
              ? "invalid-data"
              : /not supported|unsupported|webhid/i.test(message)
                ? "unsupported"
                : fallbackCode;

  // Keep the original message when it exists: the Ledger packages (and firmware)
  // describe the failure more precisely than a generic code can, and the caller
  // still gets `ledgerErrorHint(code)` for the actionable next step.
  return new LedgerError(message || ledgerErrorMessage(code), { code, cause: error });
}

/** True when the user refused the request on the device (or dismissed the prompt). */
export function isUserRejection(error: unknown): boolean {
  if (isLedgerError(error)) return error.code === "user-rejected" || error.code === "no-device";
  const name = nameOf(error);
  if (name === "NotAllowedError") return true;
  return /denied|refused|rejected by the user|user rejected|cancel/i.test(messageOf(error));
}

/** A user-facing message for any error thrown by the Ledger integration. */
export function toUserMessage(error: unknown): string {
  const normalized = normalizeLedgerError(error);
  return normalized.message || ledgerErrorMessage(normalized.code);
}

/** Render a status word the way Ledger's own tooling does, e.g. `0x6985`. */
export function formatStatusWord(status: number): string {
  return `0x${(status & 0xffff).toString(16).padStart(4, "0")}`;
}
