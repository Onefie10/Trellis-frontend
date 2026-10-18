import {
  ASSET_CODE_PATTERN,
  BASE_RESERVE_STROOPS,
  MOCK_ISSUERS,
  PUBLIC_KEY_PATTERN,
  STROOPS_PER_UNIT,
  SandboxWalletError,
  WALLET_PRESETS,
  buildMockWallet,
  buildNativeBalance,
  buildWalletFromPreset,
  deriveMockPublicKey,
  findBalance,
  formatBalance,
  fromStroops,
  getWalletPreset,
  isValidAssetCode,
  isValidPublicKey,
  minimumReserveStroops,
  normaliseAssetSpec,
  summariseWallet,
  toStroops,
  trimBalance,
  validateDraft,
  walletNativeBalance,
  walletToBalances,
} from "../../../lib/sandbox-wallet";
import {
  defaultRows,
  draftToBuildInput,
  emptyRow,
  isNativeAsset,
  resetRowIds,
  rowsToSpecs,
} from "../draft-wallet";

describe("Sandbox mock wallet balance generator", () => {
  describe("stroop conversion", () => {
    it("converts whole and fractional balances", () => {
      expect(toStroops("1000")).toBe(10_000_000_000n);
      expect(toStroops("0.8")).toBe(8_000_000n);
      expect(toStroops("1.2345678")).toBe(12_345_678n);
      expect(toStroops(25)).toBe(250_000_000n);
      expect(STROOPS_PER_UNIT).toBe(10_000_000n);
    });

    it("round-trips through the canonical 7-decimal form", () => {
      expect(fromStroops(toStroops("1000"))).toBe("1000.0000000");
      expect(fromStroops(toStroops("0.8"))).toBe("0.8000000");
      expect(fromStroops(0n)).toBe("0.0000000");
    });

    it("trims trailing zeros for display", () => {
      expect(trimBalance("1000.0000000")).toBe("1000");
      expect(trimBalance("1.5000000")).toBe("1.5");
      expect(trimBalance("0.0000000")).toBe("0");
      expect(formatBalance(toStroops("1000.5"))).toBe("1000.5");
    });

    it("rejects more than 7 decimal places", () => {
      expect(() => toStroops("0.00000001")).toThrow(SandboxWalletError);
      try {
        toStroops("0.00000001");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("DECIMAL_PRECISION");
      }
    });

    it("rejects exponent notation and non-numeric input", () => {
      try {
        toStroops(1e21);
        throw new Error("expected toStroops to reject exponent notation");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("INVALID_BALANCE");
      }
      try {
        toStroops("one hundred");
        throw new Error("expected toStroops to reject non-numeric input");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("INVALID_BALANCE");
      }
      try {
        toStroops("");
        throw new Error("expected toStroops to reject empty input");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("INVALID_BALANCE");
      }
    });
  });

  describe("asset normalisation", () => {
    it("treats native aliases alike", () => {
      for (const alias of ["native", "XLM", "xlm", "Lumens"]) {
        const asset = normaliseAssetSpec(alias);
        expect(asset.isNative).toBe(true);
        expect(asset.key).toBe("native");
        expect(asset.label).toBe("XLM");
        expect(asset.type).toBe("native");
      }
    });

    it("accepts CODE:ISSUER and CODE-ISSUER", () => {
      const colon = normaliseAssetSpec(`USDC:${MOCK_ISSUERS.usdc}`);
      expect(colon.code).toBe("USDC");
      expect(colon.issuer).toBe(MOCK_ISSUERS.usdc);
      expect(colon.key).toBe(`USDC:${MOCK_ISSUERS.usdc}`);
      expect(colon.type).toBe("credit_alphanum4");
      expect(colon.isNative).toBe(false);

      const dash = normaliseAssetSpec(`USDC-${MOCK_ISSUERS.usdc}`);
      expect(dash.key).toBe(colon.key);
    });

    it("accepts an issuer supplied separately", () => {
      const asset = normaliseAssetSpec("USDC", MOCK_ISSUERS.usdc);
      expect(asset.key).toBe(`USDC:${MOCK_ISSUERS.usdc}`);
    });

    it("uppercases the code so USDC and usdc collapse", () => {
      expect(normaliseAssetSpec("usdc", MOCK_ISSUERS.usdc).code).toBe("USDC");
      expect(normaliseAssetSpec("usdc", MOCK_ISSUERS.usdc).key).toBe(
        normaliseAssetSpec("USDC", MOCK_ISSUERS.usdc).key,
      );
    });

    it("distinguishes alphanum4 from alphanum12", () => {
      expect(normaliseAssetSpec("AQUA", MOCK_ISSUERS.aqua).type).toBe("credit_alphanum4");
      expect(normaliseAssetSpec("TWELVECHARSX", MOCK_ISSUERS.aqua).type).toBe("credit_alphanum12");
    });

    it("requires a valid issuer for credit assets", () => {
      try {
        normaliseAssetSpec("USDC");
        throw new Error("expected MISSING_ISSUER");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("MISSING_ISSUER");
        expect((error as SandboxWalletError).field).toBe("issuer");
      }
      try {
        normaliseAssetSpec("USDC:not-a-key");
        throw new Error("expected INVALID_ISSUER");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("INVALID_ISSUER");
      }
    });

    it("rejects empty and over-long asset codes", () => {
      try {
        normaliseAssetSpec("");
        throw new Error("expected EMPTY_ASSET");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("EMPTY_ASSET");
      }
      try {
        normaliseAssetSpec("THIRTEENCHARS");
        throw new Error("expected INVALID_ASSET_CODE");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("INVALID_ASSET_CODE");
      }
    });

    it("validates codes and public keys against the Stellar rules", () => {
      expect(isValidAssetCode("A")).toBe(true);
      expect(isValidAssetCode("TWELVECHARSX")).toBe(true);
      expect(isValidAssetCode("THIRTEENCHARS")).toBe(false);
      expect(isValidAssetCode("US DC")).toBe(false);
      expect(ASSET_CODE_PATTERN.test("USDC")).toBe(true);

      expect(isValidPublicKey(MOCK_ISSUERS.usdc)).toBe(true);
      expect(isValidPublicKey(MOCK_ISSUERS.eurc)).toBe(true);
      expect(isValidPublicKey(MOCK_ISSUERS.aqua)).toBe(true);
      expect(isValidPublicKey("GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7")).toBe(true);
      expect(isValidPublicKey("SBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7")).toBe(false);
      expect(PUBLIC_KEY_PATTERN.test(MOCK_ISSUERS.usdc)).toBe(true);
    });
  });

  describe("derived mock public keys", () => {
    it("is deterministic and syntactically valid", () => {
      const key = deriveMockPublicKey("preset-healthy");
      expect(key).toBe(deriveMockPublicKey("preset-healthy"));
      expect(key.length).toBe(56);
      expect(isValidPublicKey(key)).toBe(true);
      expect(key.startsWith("G")).toBe(true);
    });

    it("differs per seed", () => {
      expect(deriveMockPublicKey("a")).not.toBe(deriveMockPublicKey("b"));
    });
  });

  describe("minimum reserve", () => {
    it("is 1 XLM for a zero-subentry account and 0.5 XLM per extra subentry", () => {
      expect(minimumReserveStroops(0)).toBe(10_000_000n);
      expect(fromStroops(minimumReserveStroops(3))).toBe("2.5000000");
      expect(BASE_RESERVE_STROOPS).toBe(5_000_000n);
    });

    it("ignores negative and non-finite subentry counts", () => {
      expect(minimumReserveStroops(-4)).toBe(10_000_000n);
      expect(minimumReserveStroops(Number.NaN)).toBe(10_000_000n);
    });
  });

  describe("buildMockWallet", () => {
    it("adds a zero native balance when none was supplied", () => {
      const state = buildMockWallet({
        balances: [{ asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "10" }],
      });
      expect(state.balances.length).toBe(2);
      expect(state.balances[0].isNative).toBe(true);
      expect(state.balances[0].balance).toBe("0.0000000");
      expect(state.warnings.some((w) => w.includes("No native balance"))).toBe(true);
      expect(state.reserve.belowMinimum).toBe(true);
    });

    it("can refuse to synthesise a native balance", () => {
      try {
        buildMockWallet({
          balances: [{ asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "10" }],
          ensureNative: false,
        });
        throw new Error("expected NO_NATIVE_BALANCE");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("NO_NATIVE_BALANCE");
      }
    });

    it("rejects duplicate assets", () => {
      try {
        buildMockWallet({
          balances: [
            { asset: "native", balance: "10" },
            { asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "1" },
            { asset: "usdc", issuer: MOCK_ISSUERS.usdc, balance: "2" },
          ],
        });
        throw new Error("expected DUPLICATE_ASSET");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("DUPLICATE_ASSET");
      }
    });

    it("rejects negative, empty and malformed balances", () => {
      const cases: Array<[string, string]> = [
        ["-5", "NEGATIVE_BALANCE"],
        ["", "INVALID_BALANCE"],
        ["abc", "INVALID_BALANCE"],
      ];
      for (const [balance, code] of cases) {
        try {
          buildMockWallet({ balances: [{ asset: "native", balance }] });
          throw new Error(`expected ${code}`);
        } catch (error) {
          expect((error as SandboxWalletError).code).toBe(code);
        }
      }
    });

    it("rejects a non-positive trustline limit", () => {
      try {
        buildMockWallet({
          balances: [
            { asset: "native", balance: "10" },
            { asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "1", limit: "0" },
          ],
        });
        throw new Error("expected INVALID_LIMIT");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("INVALID_LIMIT");
      }
    });

    it("defaults the trustline limit and keeps explicit limits normalised", () => {
      const state = buildMockWallet({
        balances: [
          { asset: "native", balance: "10" },
          { asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "1" },
          { asset: "EURC", issuer: MOCK_ISSUERS.eurc, balance: "2", limit: "500" },
        ],
      });
      const usdc = findBalance(state, "USDC");
      const eurc = findBalance(state, "EURC");
      expect(usdc?.limit).toBe("922337203685.4775807");
      expect(eurc?.limit).toBe("500.0000000");
    });

    it("counts subentries and computes spendable XLM", () => {
      const state = buildMockWallet({
        balances: [
          { asset: "native", balance: "10" },
          { asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "1" },
          { asset: "EURC", issuer: MOCK_ISSUERS.eurc, balance: "1" },
        ],
      });
      expect(state.reserve.subentryCount).toBe(2);
      expect(state.reserve.minimumReserve).toBe("2.0000000");
      expect(state.reserve.spendable).toBe("8.0000000");
      expect(state.reserve.belowMinimum).toBe(false);
    });

    it("flags a wallet below the minimum reserve", () => {
      const state = buildMockWallet({
        balances: [
          { asset: "native", balance: "0.8" },
          { asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "1" },
          { asset: "EURC", issuer: MOCK_ISSUERS.eurc, balance: "1" },
          { asset: "AQUA", issuer: MOCK_ISSUERS.aqua, balance: "1" },
        ],
      });
      expect(state.reserve.subentryCount).toBe(3);
      expect(state.reserve.minimumReserve).toBe("2.5000000");
      expect(state.reserve.spendable).toBe("0.0000000");
      expect(state.reserve.belowMinimum).toBe(true);
      expect(state.warnings.some((w) => w.includes("minimum reserve"))).toBe(true);
    });

    it("warns about unauthorised trustlines and zero balances", () => {
      const state = buildMockWallet({
        balances: [
          { asset: "native", balance: "30" },
          { asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "0", authorized: false },
        ],
      });
      expect(state.warnings.some((w) => w.includes("opNOT_AUTHORIZED"))).toBe(true);
      expect(state.warnings.some((w) => w.includes("zero"))).toBe(true);
    });

    it("is deterministic for a given seed and honours an explicit key", () => {
      const first = buildMockWallet({ label: "same", seed: "seed", balances: [{ asset: "native", balance: "1" }], now: 0 });
      const second = buildMockWallet({ label: "same", seed: "seed", balances: [{ asset: "native", balance: "1" }], now: 0 });
      expect(first.publicKey).toBe(second.publicKey);
      expect(first.id).toBe(second.id);
      expect(first.generatedAt).toBe(0);

      const explicit = buildMockWallet({
        seed: "seed",
        publicKey: MOCK_ISSUERS.usdc,
        balances: [{ asset: "native", balance: "1" }],
      });
      expect(explicit.publicKey).toBe(MOCK_ISSUERS.usdc);
    });

    it("rejects an invalid explicit public key", () => {
      try {
        buildMockWallet({ publicKey: "nope", balances: [{ asset: "native", balance: "1" }] });
        throw new Error("expected INVALID_PUBLIC_KEY");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("INVALID_PUBLIC_KEY");
      }
    });
  });

  describe("wallet presets", () => {
    it("exposes the documented presets", () => {
      const ids = WALLET_PRESETS.map((p) => p.id);
      expect(ids).toContain("healthy");
      expect(ids).toContain("low-xlm");
      expect(ids).toContain("no-trustlines");
      expect(ids).toContain("unauthorised");
      expect(ids).toContain("empty");
      expect(getWalletPreset("healthy")?.label).toBeDefined();
      expect(getWalletPreset("nope")).toBeUndefined();
    });

    it("builds every preset without error", () => {
      for (const preset of WALLET_PRESETS) {
        const state = buildWalletFromPreset(preset.id, 0);
        expect(state.balances.length).toBeGreaterThan(0);
        expect(state.publicKey.length).toBe(56);
      }
    });

    it("reaches the low-balance branch with the low-xlm preset", () => {
      const state = buildWalletFromPreset("low-xlm", 0);
      expect(state.reserve.belowMinimum).toBe(true);
      expect(state.reserve.spendable).toBe("0.0000000");
      expect(state.balances.filter((b) => !b.isNative).length).toBe(3);
      expect(walletNativeBalance(state).balance).toBe("0.8000000");
    });

    it("reaches the unauthorised branch with the unauthorised preset", () => {
      const state = buildWalletFromPreset("unauthorised", 0);
      const usdc = findBalance(state, "USDC");
      expect(usdc?.authorized).toBe(false);
      expect(state.warnings.some((w) => w.includes("not authorised"))).toBe(true);
    });

    it("reaches the empty branch with the empty preset", () => {
      const state = buildWalletFromPreset("empty", 0);
      expect(state.reserve.belowMinimum).toBe(true);
      expect(walletNativeBalance(state).balanceStroops).toBe(0n);
    });

    it("throws for an unknown preset", () => {
      try {
        buildWalletFromPreset("does-not-exist");
        throw new Error("expected UNKNOWN_PRESET");
      } catch (error) {
        expect((error as SandboxWalletError).code).toBe("UNKNOWN_PRESET");
      }
    });
  });

  describe("queries and adapters", () => {
    it("finds balances with or without the issuer", () => {
      const state = buildWalletFromPreset("low-xlm", 0);
      expect(findBalance(state, "USDC")?.balance).toBe("120.0000000");
      expect(findBalance(state, `USDC:${MOCK_ISSUERS.usdc}`)?.balance).toBe("120.0000000");
      expect(findBalance(state, "native")?.code).toBe("XLM");
      expect(findBalance(state, "XLM")?.isNative).toBe(true);
      expect(findBalance(state, "NOPE")).toBeUndefined();
      expect(findBalance(state, "")).toBeUndefined();
    });

    it("shapes balances for wallet consumers", () => {
      const state = buildWalletFromPreset("healthy", 0);
      const balances = walletToBalances(state);
      expect(balances.length).toBe(2);
      expect(balances[0].asset).toBe("native");
      expect(balances[0].assetCode).toBeUndefined();
      expect(balances[1].assetCode).toBe("USDC");
      expect(balances[1].assetIssuer).toBe(MOCK_ISSUERS.usdc);
      expect(balances[1].balance).toBe("500.0000000");
    });

    it("builds a native balance with no trustline", () => {
      const native = buildNativeBalance(0n);
      expect(native.isNative).toBe(true);
      expect(native.hasTrustline).toBe(false);
      expect(native.balance).toBe("0.0000000");
      expect(native.authorized).toBe(true);
    });

    it("summarises a wallet", () => {
      const summary = summariseWallet(buildWalletFromPreset("low-xlm", 0));
      expect(summary).toContain("XLM native");
      expect(summary).toContain("3 trustlines");
      expect(summary).toContain("spendable 0 XLM");
    });
  });

  describe("validateDraft", () => {
    it("returns the built state for a valid draft", () => {
      const result = validateDraft([{ asset: "native", balance: "1" }]);
      expect(result.ok).toBe(true);
      expect(result.state?.balances.length).toBe(1);
    });

    it("returns the error without throwing for an invalid draft", () => {
      const missingIssuer = validateDraft([{ asset: "USDC", balance: "1" }]);
      expect(missingIssuer.ok).toBe(false);
      expect(missingIssuer.error?.code).toBe("MISSING_ISSUER");
      expect(missingIssuer.error?.field).toBe("issuer");
      expect(missingIssuer.state).toBeUndefined();

      const duplicate = validateDraft([
        { asset: "native", balance: "1" },
        { asset: "native", balance: "2" },
      ]);
      expect(duplicate.ok).toBe(false);
      expect(duplicate.error?.code).toBe("DUPLICATE_ASSET");
    });
  });

  describe("draft rows", () => {
    it("maps rows onto generator input", () => {
      const specs = rowsToSpecs([
        {
          id: "a",
          asset: "native",
          issuer: "",
          balance: "25",
          limit: "",
          authorized: true,
          sponsored: false,
        },
        {
          id: "b",
          asset: "USDC",
          issuer: MOCK_ISSUERS.usdc,
          balance: "10",
          limit: "500",
          authorized: false,
          sponsored: true,
        },
      ]);

      expect(specs.length).toBe(2);
      expect(specs[0].issuer).toBeUndefined();
      expect(specs[0].limit).toBeUndefined();
      expect(specs[1].issuer).toBe(MOCK_ISSUERS.usdc);
      expect(specs[1].limit).toBe("500");
      expect(specs[1].authorized).toBe(false);
      expect(specs[1].sponsored).toBe(true);
      expect(validateDraft(specs).ok).toBe(true);
    });

    it("skips blank assets and treats a blank balance as zero", () => {
      const specs = rowsToSpecs([
        {
          id: "a",
          asset: "   ",
          issuer: "",
          balance: "5",
          limit: "",
          authorized: true,
          sponsored: false,
        },
        {
          id: "b",
          asset: " native ",
          issuer: "",
          balance: "",
          limit: "",
          authorized: true,
          sponsored: false,
        },
      ]);

      expect(specs.length).toBe(1);
      expect(specs[0].asset).toBe("native");
      expect(specs[0].balance).toBe("0");
    });

    it("builds the default rows from the healthy preset", () => {
      const rows = defaultRows();
      expect(rows.length).toBe(2);
      expect(rows[0].asset).toBe("native");
      expect(rows[1].asset).toBe("USDC");
      expect(rows[1].issuer).toBe(MOCK_ISSUERS.usdc);
      expect(validateDraft(rowsToSpecs(rows)).ok).toBe(true);
    });

    it("assigns unique row ids", () => {
      resetRowIds();
      const ids = [emptyRow().id, emptyRow().id, emptyRow().id];
      expect(new Set(ids).size).toBe(3);
    });

    it("detects the native asset aliases", () => {
      expect(isNativeAsset("native")).toBe(true);
      expect(isNativeAsset(" XLM ")).toBe(true);
      expect(isNativeAsset("USDC")).toBe(false);
    });

    it("builds labelled generator input from a draft", () => {
      expect(draftToBuildInput([], "  ").label).toBe("Sandbox wallet");
      expect(draftToBuildInput([], "My wallet").label).toBe("My wallet");
      expect(draftToBuildInput([], "My wallet").network).toBe("testnet");
      expect(draftToBuildInput([], "My wallet").seed).toBe("ui-wallet");
    });
  });
});
