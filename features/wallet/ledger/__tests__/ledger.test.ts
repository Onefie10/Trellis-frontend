import {
  ApduStrApp,
  LEDGER_ADDRESS_STEP,
  LEDGER_APDU_PAYLOAD_SIZE,
  LEDGER_CLA,
  LEDGER_GUIDE_STEPS,
  LEDGER_INS,
  LEDGER_P1,
  LEDGER_P2,
  LEDGER_STATUS_WORDS,
  LedgerError,
  LedgerWalletAdapter,
  STELLAR_DERIVATION_PATH,
  SW_OK,
  accountFromPublicKey,
  assertStellarBip32Path,
  bytesToHex,
  connectLedgerWallet,
  createLedgerStrApp,
  createLedgerTransport,
  crc16xmodem,
  decodeEd25519PublicKey,
  derToRawSignature,
  deriveAccountPath,
  disconnectLedger,
  encodeEd25519PublicKey,
  formatBip32Path,
  formatStatusWord,
  getActiveLedgerAdapter,
  guideStepForError,
  hexToBytes,
  isLedgerConnected,
  isLedgerError,
  isValidBip32Path,
  isValidEd25519PublicKey,
  isUserRejection,
  isWebHidSupported,
  ledgerErrorCodeForStatus,
  ledgerErrorFromStatus,
  ledgerErrorHint,
  ledgerErrorMessage,
  normalizeLedgerError,
  parseBip32Path,
  parseLedgerSignature,
  pathToBytes,
  setActiveLedgerAdapter,
  signWithLedger,
  signatureHintFor,
  signatureHintOf,
  statusCodeOf,
  stripStatus,
  toUint8Array,
  toUserMessage,
  wrapTransport,
  type LedgerErrorCode,
  type LedgerStrApp,
  type LedgerTransport,
} from "../index";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

const TEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const TEST_SIGNATURE = Uint8Array.from({ length: 64 }, (_, index) => 0xff - index);

function withStatus(bytes: Uint8Array, status = SW_OK): Uint8Array {
  const output = new Uint8Array(bytes.length + 2);
  output.set(bytes, 0);
  output[bytes.length] = (status >> 8) & 0xff;
  output[bytes.length + 1] = status & 0xff;
  return output;
}

interface TransportCall {
  cla: number;
  ins: number;
  p1: number;
  p2: number;
  data?: Uint8Array;
}

/** Records every APDU and replays queued responses. */
class FakeWebHidTransport {
  readonly calls: TransportCall[] = [];
  closeCount = 0;
  decorated = false;
  private queue: Uint8Array[] = [];

  constructor(private readonly defaultResponse: Uint8Array = withStatus(TEST_KEY)) {}

  queueResponse(response: Uint8Array): void {
    this.queue.push(response);
  }

  async send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
  ): Promise<Uint8Array> {
    this.calls.push({
      cla,
      ins,
      p1,
      p2,
      data: data ? Uint8Array.from(data) : undefined,
    });
    const queued = this.queue.shift();
    return queued ?? this.defaultResponse;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  decorateAppAPIMethods(): void {
    this.decorated = true;
  }
}

/** In-memory `LedgerStrApp` used to drive the adapter deterministically. */
class FakeStrApp implements LedgerStrApp {
  readonly kind = "fake";
  publicKeyCalls: Array<{ derivationPath: string; display?: boolean }> = [];
  signCalls: Array<{ derivationPath: string; payload: Uint8Array }> = [];
  sorobanCalls: Array<{ derivationPath: string; payload: Uint8Array }> = [];
  hashCalls: Array<{ derivationPath: string; payload: Uint8Array }> = [];
  closeCount = 0;

  constructor(
    private readonly publicKey: Uint8Array = TEST_KEY,
    private readonly signature: Uint8Array = TEST_SIGNATURE,
    private readonly failure: Error | null = null,
  ) {}

  async getAppConfiguration() {
    return { version: "1.2.3", hashSigningEnabled: true, maxDataSize: 1024 };
  }

  async getPublicKey(derivationPath: string, options: { display?: boolean } = {}) {
    this.publicKeyCalls.push({ derivationPath, display: options.display });
    if (this.failure) throw this.failure;
    return this.publicKey;
  }

  async signTransaction(derivationPath: string, signatureBase: Uint8Array) {
    this.signCalls.push({ derivationPath, payload: signatureBase });
    if (this.failure) throw this.failure;
    return this.signature;
  }

  async signSorobanAuthorization(derivationPath: string, preimage: Uint8Array) {
    this.sorobanCalls.push({ derivationPath, payload: preimage });
    return this.signature;
  }

  async signHash(derivationPath: string, hash: Uint8Array) {
    this.hashCalls.push({ derivationPath, payload: hash });
    return this.signature;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

async function captureLedgerError(
  promise: Promise<unknown>,
  code: LedgerErrorCode,
): Promise<LedgerError> {
  try {
    await promise;
  } catch (error) {
    if (!isLedgerError(error)) {
      throw new Error(`expected a LedgerError(${code}), got ${String(error)}`);
    }
    if (error.code !== code) {
      throw new Error(`expected code "${code}", got "${error.code}" (${error.message})`);
    }
    return error;
  }
  throw new Error(`expected a LedgerError(${code}) but the promise resolved`);
}

function withGlobals(values: Record<string, unknown>, run: () => void): void {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of Object.keys(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  try {
    run();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* StrKey                                                                     */
/* -------------------------------------------------------------------------- */

describe("strkey", () => {
  it("matches the known all-zero Ed25519 address vector", () => {
    expect(encodeEd25519PublicKey(new Uint8Array(32))).toBe(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
  });

  it("uses the CRC16-XModem checksum from the StrKey spec", () => {
    const input = Uint8Array.from("123456789", (character) => character.charCodeAt(0));
    expect(crc16xmodem(input)).toBe(0x31c3);
  });

  it("round-trips a real Stellar address", () => {
    // Circle's USDC issuer account, decoded independently with the StrKey spec.
    const address = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const raw =
      "3b9911380efe988ba0a8900eb1cfe44f366f7dbe946bed077240f7f624df15c5";

    expect(bytesToHex(decodeEd25519PublicKey(address))).toBe(raw);
    expect(encodeEd25519PublicKey(hexToBytes(raw))).toBe(address);
  });

  it("rejects a corrupted checksum and a truncated payload", () => {
    const valid = encodeEd25519PublicKey(TEST_KEY);
    const corrupted = `${valid.slice(0, 10)}A${valid.slice(11)}`;
    expect(isValidEd25519PublicKey(corrupted)).toBe(false);
    expect(isValidEd25519PublicKey(valid.slice(0, 40))).toBe(false);
    expect(isValidEd25519PublicKey(valid)).toBe(true);
  });

  it("throws when encoding a key that is not 32 bytes", () => {
    // The codec itself throws a plain Error; the adapter wraps it into a LedgerError.
    expect(() => encodeEd25519PublicKey(new Uint8Array(31))).toThrow();
    expect(() => decodeEd25519PublicKey("not-an-address")).toThrow();
  });

  it("derives the signature hint from the last four key bytes", () => {
    expect(bytesToHex(signatureHintFor(TEST_KEY))).toBe("1c1d1e1f");
    expect(() => signatureHintFor(new Uint8Array(31))).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* BIP-32 paths                                                               */
/* -------------------------------------------------------------------------- */

describe("bip32 paths", () => {
  it("parses hardened segments and preserves order", () => {
    const segments = parseBip32Path("44'/148'/0'");
    expect(segments.length).toBe(3);
    expect(segments[0].index).toBe(44);
    expect(segments[0].hardened).toBe(true);
    expect(segments[1].index).toBe(148);
    expect(segments[2].index).toBe(0);
    expect(segments[2].hardened).toBe(true);
  });

  it("accepts m/ prefixes and h/H hardened markers", () => {
    expect(formatBip32Path(parseBip32Path("m/44'/148'/7'"))).toBe("44'/148'/7'");
    expect(formatBip32Path(parseBip32Path("44h/148H/7"))).toBe("44'/148'/7");
  });

  it("rejects malformed paths", () => {
    expect(isValidBip32Path("44'/abc/0'")).toBe(false);
    expect(isValidBip32Path("")).toBe(false);
    expect(() => parseBip32Path("44'/148'/99999999999'")).toThrow();
  });

  it("validates Stellar account paths", () => {
    expect(assertStellarBip32Path("m/44'/148'/2'")).toBe("44'/148'/2'");
    expect(assertStellarBip32Path("")).toBe(STELLAR_DERIVATION_PATH);
    expect(() => assertStellarBip32Path("44'/148'")).toThrow();
    expect(() => assertStellarBip32Path("44'/148/0'")).toThrow();
    expect(() => assertStellarBip32Path("44'/60'/0'")).toThrow();
    expect(() => assertStellarBip32Path("m/44'/148'/0")).toThrow();
  });

  it("builds account paths", () => {
    expect(deriveAccountPath(2)).toBe("44'/148'/2'");
    expect(deriveAccountPath()).toBe("44'/148'/0'");
    expect(() => deriveAccountPath(-1)).toThrow();
  });

  it("serialises paths for the Stellar app APDU", () => {
    const bytes = pathToBytes("44'/148'/0'");
    expect(bytes.length).toBe(13);
    expect(bytes[0]).toBe(3);
    expect(bytesToHex(bytes)).toBe("03" + "8000002c" + "80000094" + "80000000");
  });

  it("hardens un-hardened segments by default, like bip32-path does", () => {
    expect(bytesToHex(pathToBytes("44/148"))).toBe("02" + "8000002c" + "80000094");
    expect(bytesToHex(pathToBytes("44/148", { harden: false }))).toBe("02" + "0000002c" + "00000094");
  });
});

/* -------------------------------------------------------------------------- */
/* Signature payload parsing                                                  */
/* -------------------------------------------------------------------------- */

describe("signature payload parsing", () => {
  it("round-trips hex helpers", () => {
    expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
    expect(bytesToHex(hexToBytes("0x00ff10"))).toBe("00ff10");
    expect(() => hexToBytes("zz")).toThrow(LedgerError);
  });

  it("accepts raw, wrapped, hex and base64 signatures", () => {
    expect(bytesToHex(parseLedgerSignature(TEST_SIGNATURE))).toBe(bytesToHex(TEST_SIGNATURE));
    expect(bytesToHex(parseLedgerSignature({ signature: TEST_SIGNATURE }))).toBe(
      bytesToHex(TEST_SIGNATURE),
    );
    expect(bytesToHex(parseLedgerSignature({ signatureHex: bytesToHex(TEST_SIGNATURE) }))).toBe(
      bytesToHex(TEST_SIGNATURE),
    );

    const base64 = Buffer.from(TEST_SIGNATURE).toString("base64");
    expect(bytesToHex(parseLedgerSignature(base64))).toBe(bytesToHex(TEST_SIGNATURE));
  });

  it("converts a DER encoded signature into the raw 64-byte form", () => {
    const der = derEncode(TEST_SIGNATURE.slice(0, 32), TEST_SIGNATURE.slice(32));
    // Both integers have the high bit set, so DER needs a leading 0x00 on each.
    expect(der.length).toBe(2 + (2 + 33) + (2 + 33));
    expect(bytesToHex(derToRawSignature(der))).toBe(bytesToHex(TEST_SIGNATURE));
    expect(bytesToHex(parseLedgerSignature(der))).toBe(bytesToHex(TEST_SIGNATURE));
  });

  it("left-pads short DER integers and strips surplus leading zeros", () => {
    const r = new Uint8Array(32);
    r.fill(0xab);
    const s = new Uint8Array(32);
    s[31] = 0x01;

    const der = derEncode(r, s);
    expect(der.length).toBe(2 + (2 + 33) + (2 + 1));
    expect(bytesToHex(derToRawSignature(der))).toBe(bytesToHex(concatBytes(r, s)));
  });

  it("rejects malformed signature payloads", () => {
    expect(() => parseLedgerSignature(new Uint8Array(32))).toThrow(LedgerError);
    expect(() => parseLedgerSignature(Uint8Array.from({ length: 70 }, () => 0x01))).toThrow(
      LedgerError,
    );
    expect(() => parseLedgerSignature({ unexpected: true })).toThrow(LedgerError);
  });

  it("returns a user-facing code rather than guessing", () => {
    try {
      parseLedgerSignature(new Uint8Array(32));
    } catch (error) {
      expect(isLedgerError(error)).toBe(true);
      expect((error as LedgerError).code).toBe("invalid-signature");
    }
  });

  it("coerces byte-ish payloads and rejects everything else", () => {
    expect(bytesToHex(toUint8Array([1, 2, 3]))).toBe("010203");
    expect(bytesToHex(toUint8Array(Uint8Array.from([1, 2, 3]).buffer))).toBe("010203");
    expect(() => toUint8Array({ nope: 1 })).toThrow(LedgerError);
    expect(() => toUint8Array([1, 999])).toThrow(LedgerError);
  });

  it("builds accounts from a device public key", () => {
    const account = accountFromPublicKey(TEST_KEY, "44'/148'/0'");
    expect(account.address).toBe(encodeEd25519PublicKey(TEST_KEY));
    expect(account.publicKey).toBe(account.address);
    expect(account.derivationPath).toBe("44'/148'/0'");
    expect(bytesToHex(signatureHintOf(account))).toBe("1c1d1e1f");
    expect(() => accountFromPublicKey(new Uint8Array(31), "44'/148'/0'")).toThrow(LedgerError);
  });
});

/** Minimal DER `SEQUENCE { r INTEGER, s INTEGER }` encoder for the tests. */
function derEncode(r: Uint8Array, s: Uint8Array): Uint8Array {
  const encodeInteger = (value: Uint8Array): Uint8Array => {
    const needsZero = (value[0] & 0x80) !== 0;
    const body = needsZero
      ? concatBytes(new Uint8Array([0x00]), value)
      : trimLeadingZeros(value);
    return concatBytes(new Uint8Array([0x02, body.length]), body);
  };

  const body = concatBytes(encodeInteger(r), encodeInteger(s));
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

function trimLeadingZeros(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0x00) start += 1;
  return value.subarray(start);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

/* -------------------------------------------------------------------------- */
/* Errors and status words                                                    */
/* -------------------------------------------------------------------------- */

describe("ledger errors", () => {
  const allCodes: LedgerErrorCode[] = [
    "unsupported",
    "unavailable",
    "no-device",
    "locked",
    "app-not-open",
    "wrong-app",
    "user-rejected",
    "hash-signing-disabled",
    "data-too-large",
    "invalid-data",
    "invalid-path",
    "invalid-signature",
    "invalid-response",
    "transport",
    "unknown",
  ];

  it("maps Stellar app status words to codes", () => {
    expect(ledgerErrorCodeForStatus(LEDGER_STATUS_WORDS.DENY)).toBe("user-rejected");
    expect(ledgerErrorCodeForStatus(LEDGER_STATUS_WORDS.APP_NOT_OPEN)).toBe("app-not-open");
    expect(ledgerErrorCodeForStatus(LEDGER_STATUS_WORDS.WRONG_APP)).toBe("wrong-app");
    expect(ledgerErrorCodeForStatus(LEDGER_STATUS_WORDS.LOCKED)).toBe("locked");
    expect(ledgerErrorCodeForStatus(LEDGER_STATUS_WORDS.HASH_SIGNING_DISABLED)).toBe(
      "hash-signing-disabled",
    );
    expect(ledgerErrorCodeForStatus(LEDGER_STATUS_WORDS.DATA_TOO_LARGE)).toBe("data-too-large");
    expect(ledgerErrorCodeForStatus(LEDGER_STATUS_WORDS.DATA_PARSING_FAILED)).toBe("invalid-data");
  });

  it("builds descriptive errors from status words", () => {
    const error = ledgerErrorFromStatus(LEDGER_STATUS_WORDS.DENY);
    expect(error.code).toBe("user-rejected");
    expect(error.statusCode).toBe(0x6985);
    expect(error.message).toMatch(/0x6985/);
    expect(error.message).toMatch(/rejected/i);
    expect(formatStatusWord(0x6985)).toBe("0x6985");
    expect(ledgerErrorFromStatus(0x9999).code).toBe("unknown");
  });

  it("extracts status codes from transports and messages", () => {
    expect(statusCodeOf({ statusCode: 0x6985 })).toBe(0x6985);
    expect(statusCodeOf(new Error("Ledger device: Condition of use not satisfied (0x6985)"))).toBe(
      0x6985,
    );
    expect(statusCodeOf(new Error("nothing to see here"))).toBe(null);
  });

  it("normalises WebHID DOM exceptions", () => {
    const notAllowed = new Error("user declined");
    (notAllowed as { name: string }).name = "NotAllowedError";
    expect(normalizeLedgerError(notAllowed).code).toBe("no-device");
    expect(isUserRejection(notAllowed)).toBe(true);

    const security = new Error("blocked");
    (security as { name: string }).name = "SecurityError";
    expect(normalizeLedgerError(security).code).toBe("unavailable");

    const network = new Error("interface busy");
    (network as { name: string }).name = "NetworkError";
    expect(normalizeLedgerError(network).code).toBe("transport");
  });

  it("recognises hw-app-str error shapes and keeps their message", () => {
    const refused = new Error("User refused the request");
    const normalized = normalizeLedgerError(refused);
    expect(normalized.code).toBe("user-rejected");
    expect(normalized.message).toBe("User refused the request");

    const hashSigning = new Error(
      "Hash signing not allowed. Have you enabled it in the app settings?",
    );
    expect(normalizeLedgerError(hashSigning).code).toBe("hash-signing-disabled");

    const tooLarge = new Error("The provided data is too large for the device to process");
    expect(normalizeLedgerError(tooLarge).code).toBe("data-too-large");
  });

  it("passes LedgerErrors through untouched", () => {
    const original = new LedgerError("boom", { code: "locked" });
    expect(normalizeLedgerError(original)).toBe(original);
  });

  it("always has a message and a hint for every code", () => {
    for (const code of allCodes) {
      expect(ledgerErrorMessage(code).length).toBeGreaterThan(10);
      expect(ledgerErrorHint(code).length).toBeGreaterThan(10);
    }
    expect(toUserMessage(new Error("custom transport failure"))).toBe("custom transport failure");
    expect(toUserMessage(new Error(""))).toBe(ledgerErrorMessage("unknown"));
  });

  it("describes the device walkthrough and maps errors to steps", () => {
    expect(LEDGER_GUIDE_STEPS.length).toBe(5);
    expect(LEDGER_GUIDE_STEPS[0].title).toMatch(/Connect/i);
    expect(LEDGER_GUIDE_STEPS[1].title).toMatch(/Unlock/i);
    expect(LEDGER_GUIDE_STEPS[2].title).toMatch(/Stellar app/i);
    expect(LEDGER_GUIDE_STEPS[3].title).toMatch(/address/i);
    expect(LEDGER_GUIDE_STEPS[4].title).toMatch(/transaction/i);
    expect(LEDGER_ADDRESS_STEP).toBe(3);

    expect(guideStepForError("no-device")).toBe(0);
    expect(guideStepForError("locked")).toBe(1);
    expect(guideStepForError("wrong-app")).toBe(2);
    expect(guideStepForError("user-rejected")).toBe(3);
    expect(guideStepForError("data-too-large")).toBe(4);
    expect(guideStepForError(null)).toBe(-1);

    // Every actionable code must point at a step so the UI can highlight it.
    for (const code of allCodes) {
      if (code === "unknown") continue;
      expect(guideStepForError(code) >= 0).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* APDU client                                                                */
/* -------------------------------------------------------------------------- */

describe("APDU Stellar app client", () => {
  it("reads the app configuration", async () => {
    const transport = new FakeWebHidTransport();
    transport.queueResponse(withStatus(Uint8Array.from([1, 5, 3, 1, 0x04, 0x00])));
    const app = new ApduStrApp(transport as unknown as LedgerTransport);

    const config = await app.getAppConfiguration();
    expect(config.version).toBe("5.3.1");
    expect(config.hashSigningEnabled).toBe(true);
    expect(config.maxDataSize).toBe(1024);
    expect(transport.calls[0].cla).toBe(LEDGER_CLA);
    expect(transport.calls[0].ins).toBe(LEDGER_INS.GET_APP_CONFIGURATION);
    expect(transport.calls[0].p1).toBe(LEDGER_P1.FIRST);
    expect(transport.calls[0].p2).toBe(LEDGER_P2.LAST);
  });

  it("requests the public key with the display flag in P2", async () => {
    const transport = new FakeWebHidTransport();
    transport.queueResponse(withStatus(TEST_KEY));
    const app = new ApduStrApp(transport as unknown as LedgerTransport);

    const key = await app.getPublicKey("44'/148'/0'", { display: true });
    expect(bytesToHex(key)).toBe(bytesToHex(TEST_KEY));

    const call = transport.calls[0];
    expect(call.cla).toBe(LEDGER_CLA);
    expect(call.ins).toBe(LEDGER_INS.GET_PUBLIC_KEY);
    expect(call.p1).toBe(LEDGER_P1.FIRST);
    expect(call.p2).toBe(0x01);
    expect(call.data ? bytesToHex(call.data) : "").toBe(bytesToHex(pathToBytes("44'/148'/0'")));
  });

  it("chunks large signing payloads the way hw-app-str does", async () => {
    const transport = new FakeWebHidTransport(withStatus(TEST_SIGNATURE));
    const app = new ApduStrApp(transport as unknown as LedgerTransport);
    const signatureBase = Uint8Array.from({ length: 600 }, (_, index) => index % 256);

    const signature = await app.signTransaction("44'/148'/0'", signatureBase);
    expect(bytesToHex(signature)).toBe(bytesToHex(TEST_SIGNATURE));

    const calls = transport.calls;
    expect(calls.length).toBe(3);
    expect(calls[0].p1).toBe(LEDGER_P1.FIRST);
    expect(calls[0].p2).toBe(LEDGER_P2.MORE);
    expect(calls[1].p1).toBe(LEDGER_P1.MORE);
    expect(calls[1].p2).toBe(LEDGER_P2.MORE);
    expect(calls[2].p1).toBe(LEDGER_P1.MORE);
    expect(calls[2].p2).toBe(LEDGER_P2.LAST);
    expect(calls.map((call) => call.data?.length ?? 0)).toEqual([
      LEDGER_APDU_PAYLOAD_SIZE,
      LEDGER_APDU_PAYLOAD_SIZE,
      13 + 600 - 2 * LEDGER_APDU_PAYLOAD_SIZE,
    ]);

    const firstChunk = calls[0].data ?? new Uint8Array(0);
    expect(firstChunk.length).toBe(LEDGER_APDU_PAYLOAD_SIZE);
    expect(bytesToHex(firstChunk.subarray(0, 13))).toBe(bytesToHex(pathToBytes("44'/148'/0'")));
  });

  it("sends a single APDU when the payload fits", async () => {
    const transport = new FakeWebHidTransport(withStatus(TEST_SIGNATURE));
    const app = new ApduStrApp(transport as unknown as LedgerTransport);

    await app.signSorobanAuthorization("44'/148'/0'", new Uint8Array(32));
    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0].ins).toBe(LEDGER_INS.SIGN_SOROBAN_AUTHORIZATION);
    expect(transport.calls[0].p2).toBe(LEDGER_P2.LAST);

    await app.signHash("44'/148'/0'", new Uint8Array(32));
    expect(transport.calls[1].ins).toBe(LEDGER_INS.SIGN_HASH);
  });

  it("turns non-success status words into typed errors", async () => {
    const transport = new FakeWebHidTransport();
    transport.queueResponse(withStatus(new Uint8Array(0), LEDGER_STATUS_WORDS.DENY));
    const app = new ApduStrApp(transport as unknown as LedgerTransport);

    const error = await captureLedgerError(app.getPublicKey("44'/148'/0'"), "user-rejected");
    expect(error.statusCode).toBe(0x6985);
  });

  it("validates status trailers", () => {
    expect(bytesToHex(stripStatus(withStatus(TEST_KEY)))).toBe(bytesToHex(TEST_KEY));
    expect(() => stripStatus(new Uint8Array([0x01]))).toThrow(LedgerError);
    try {
      stripStatus(withStatus(new Uint8Array(0), LEDGER_STATUS_WORDS.HASH_SIGNING_DISABLED));
    } catch (error) {
      expect(isLedgerError(error)).toBe(true);
      expect((error as LedgerError).code).toBe("hash-signing-disabled");
    }
  });

  it("closes the transport", async () => {
    const transport = new FakeWebHidTransport();
    const app = new ApduStrApp(transport as unknown as LedgerTransport);
    await app.close();
    expect(transport.closeCount).toBe(1);
  });

  it("selects the injected or built-in app client", async () => {
    const transport = new FakeWebHidTransport();
    const injected = new FakeStrApp();
    const chosen = await createLedgerStrApp(transport as unknown as LedgerTransport, {
      strAppFactory: () => injected,
    });
    expect(chosen).toBe(injected);

    const builtIn = await createLedgerStrApp(transport as unknown as LedgerTransport, {
      preferVendorApp: false,
    });
    expect(builtIn.kind).toBe("apdu");
  });
});

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

describe("webhid transport", () => {
  it("reports WebHID availability", () => {
    expect(isWebHidSupported()).toBe(false);

    withGlobals({ navigator: { hid: { requestDevice: () => undefined } } }, () => {
      expect(isWebHidSupported()).toBe(true);
    });

    withGlobals(
      { navigator: { hid: { requestDevice: () => undefined } }, isSecureContext: false },
      () => {
        expect(isWebHidSupported()).toBe(false);
      },
    );

    withGlobals({ navigator: {} }, () => {
      expect(isWebHidSupported()).toBe(false);
    });
  });

  it("wraps a transport and forwards calls", async () => {
    const raw = new FakeWebHidTransport();
    const wrapped = wrapTransport(raw);

    const response = await wrapped.send(LEDGER_CLA, LEDGER_INS.GET_PUBLIC_KEY, 0, 0, TEST_KEY);
    expect(bytesToHex(response)).toBe(bytesToHex(withStatus(TEST_KEY)));
    expect(raw.calls.length).toBe(1);
    expect(raw.calls[0].data ? bytesToHex(raw.calls[0].data) : "").toBe(bytesToHex(TEST_KEY));

    wrapped.decorateAppAPIMethods?.({}, ["getPublicKey"], "l0v");
    expect(raw.decorated).toBe(true);

    await wrapped.close();
    expect(raw.closeCount).toBe(1);
  });

  it("rejects transports without send()", () => {
    expect(() => wrapTransport({})).toThrow(LedgerError);
    expect(() => wrapTransport(null)).toThrow(LedgerError);
  });

  it("creates transports through the factory", async () => {
    const raw = new FakeWebHidTransport();
    const transport = await createLedgerTransport({ transportFactory: async () => raw });
    await transport.send(LEDGER_CLA, LEDGER_INS.GET_APP_CONFIGURATION, 0, 0);
    expect(raw.calls.length).toBe(1);
  });

  it("maps factory failures and missing WebHID to typed errors", async () => {
    const declined = new Error("user closed the chooser");
    (declined as { name: string }).name = "NotAllowedError";
    await captureLedgerError(
      createLedgerTransport({ transportFactory: async () => Promise.reject(declined) }),
      "no-device",
    );

    await captureLedgerError(createLedgerTransport(), "unsupported");
  });
});

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

describe("ledger wallet adapter", () => {
  it("connects, derives the account and caches it", async () => {
    const app = new FakeStrApp();
    const adapter = await LedgerWalletAdapter.connect({
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strApp: app,
    });

    const first = await adapter.getAccount();
    const second = await adapter.getAccount();
    expect(first.address).toBe(encodeEd25519PublicKey(TEST_KEY));
    expect(second.address).toBe(first.address);
    expect(app.publicKeyCalls.length).toBe(1);
    expect(app.publicKeyCalls[0].derivationPath).toBe("44'/148'/0'");
    expect(app.publicKeyCalls[0].display).toBe(false);

    await adapter.getAccount({ display: true });
    expect(app.publicKeyCalls.length).toBe(2);
    expect(app.publicKeyCalls[1].display).toBe(true);
  });

  it("honours a custom derivation path and rejects invalid ones", async () => {
    const app = new FakeStrApp();
    const adapter = await LedgerWalletAdapter.connect({
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strApp: app,
      derivationPath: "m/44'/148'/4'",
    });

    await adapter.getAccount();
    expect(app.publicKeyCalls[0].derivationPath).toBe("44'/148'/4'");

    const error = await captureLedgerError(
      LedgerWalletAdapter.connect({ derivationPath: "44'/148'/0" }),
      "invalid-path",
    );
    expect(error.message).toMatch(/hardened/i);
  });

  it("rejects a public key that is not 32 bytes", async () => {
    const adapter = await LedgerWalletAdapter.connect({
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strApp: new FakeStrApp(new Uint8Array(31)),
    });
    await captureLedgerError(adapter.getAccount(), "invalid-response");
  });

  it("signs the transaction signature base and returns the hint", async () => {
    const app = new FakeStrApp();
    const adapter = await LedgerWalletAdapter.connect({
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strApp: app,
    });
    const base = Uint8Array.from({ length: 40 }, (_, index) => index);

    const result = await adapter.signTransaction({ signatureBase: () => base });
    expect(result.signatureHex).toBe(bytesToHex(TEST_SIGNATURE));
    expect(result.hintHex).toBe("1c1d1e1f");
    expect(result.address).toBe(encodeEd25519PublicKey(TEST_KEY));
    expect(result.derivationPath).toBe("44'/148'/0'");
    expect(app.signCalls.length).toBe(1);
    expect(bytesToHex(app.signCalls[0].payload)).toBe(bytesToHex(base));
    expect(app.signCalls[0].derivationPath).toBe("44'/148'/0'");

    const hashResult = await adapter.signHash(new Uint8Array(32));
    expect(hashResult.hintHex).toBe("1c1d1e1f");
    expect(app.hashCalls.length).toBe(1);

    const sorobanResult = await adapter.signSorobanAuthorization(new Uint8Array(48));
    expect(sorobanResult.hintHex).toBe("1c1d1e1f");
    expect(app.sorobanCalls.length).toBe(1);
  });

  it("requires signatureBase() on the transaction", async () => {
    const adapter = await LedgerWalletAdapter.connect({
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strApp: new FakeStrApp(),
    });

    await captureLedgerError(
      adapter.signTransaction({} as unknown as { signatureBase: () => Uint8Array }),
      "invalid-data",
    );
  });

  it("propagates device rejections as user-rejected", async () => {
    const refused = new LedgerError("User refused the request", { code: "user-rejected" });
    const adapter = await LedgerWalletAdapter.connect({
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strApp: new FakeStrApp(TEST_KEY, TEST_SIGNATURE, refused),
    });

    const error = await captureLedgerError(adapter.getAccount(), "user-rejected");
    expect(isUserRejection(error)).toBe(true);
  });

  it("stops signing once disconnected", async () => {
    const raw = new FakeWebHidTransport();
    const adapter = await LedgerWalletAdapter.connect({
      transportFactory: async () => raw,
      strAppFactory: (transport) => new ApduStrApp(transport),
    });

    const account = await adapter.getAccount();
    expect(account.address).toBe(encodeEd25519PublicKey(TEST_KEY));
    expect(raw.calls[0].ins).toBe(LEDGER_INS.GET_PUBLIC_KEY);

    // The device answers the signing APDU with a 64-byte signature + status word.
    raw.queueResponse(withStatus(TEST_SIGNATURE));
    const signed = await adapter.signSignatureBase(new Uint8Array(16));
    expect(signed.signatureHex).toBe(bytesToHex(TEST_SIGNATURE));

    await adapter.disconnect();
    expect(adapter.isConnected).toBe(false);
    expect(raw.closeCount).toBe(1);
    await captureLedgerError(adapter.signSignatureBase(new Uint8Array(16)), "transport");
  });

  it("reuses and releases the module level session", async () => {
    setActiveLedgerAdapter(null);
    expect(getActiveLedgerAdapter()).toBe(null);
    expect(isLedgerConnected()).toBe(false);

    const first = await connectLedgerWallet({
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strAppFactory: () => new FakeStrApp(),
    });
    const second = await connectLedgerWallet({
      transportFactory: async () => new FakeWebHidTransport(),
    });
    expect(second).toBe(first);
    expect(isLedgerConnected()).toBe(true);

    const base = new Uint8Array(24);
    const signed = await signWithLedger({ signatureBase: () => base });
    expect(signed.signatureHex).toBe(bytesToHex(TEST_SIGNATURE));

    const replacement = await connectLedgerWallet({
      force: true,
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strAppFactory: () => new FakeStrApp(),
    });
    expect(replacement === first).toBe(false);
    expect(getActiveLedgerAdapter()).toBe(replacement);

    await disconnectLedger();
    expect(getActiveLedgerAdapter()).toBe(null);
    expect(isLedgerConnected()).toBe(false);
  });

  it("closes the previous session when forcing a reconnect", async () => {
    setActiveLedgerAdapter(null);
    const app = new FakeStrApp();
    await connectLedgerWallet({
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strApp: app,
    });
    await connectLedgerWallet({
      force: true,
      transport: new FakeWebHidTransport() as unknown as LedgerTransport,
      strApp: new FakeStrApp(),
    });
    // The injected transport belongs to the caller, so only the session is dropped.
    expect(getActiveLedgerAdapter()).toBeTruthy();
    await disconnectLedger();
  });
});
