import { FreighterAdapter, AlbedoAdapter, xBullAdapter, getAdapter, getAllAdapters } from "@/lib/wallet/StellarWalletAdapter";

describe("StellarWalletAdapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).freighter;
    delete (global as any).albedo;
    delete (global as any).xBull;
  });

  describe("FreighterAdapter", () => {
    let adapter: FreighterAdapter;

    beforeEach(() => {
      adapter = new FreighterAdapter();
    });

    it("has correct name and type", () => {
      expect(adapter.name).toBe("Freighter");
      expect(adapter.type).toBe("freighter");
    });

    it("isAvailable returns false when freighter-api throws", async () => {
      jest.mock("@stellar/freighter-api", () => ({
        isConnected: jest.fn().mockRejectedValue(new Error("Not installed")),
      }));
      const result = await adapter.isAvailable();
      expect(result).toBe(false);
    });

    it("connect calls getAddress and returns public key", async () => {
      const mockAddress = "GCZAJM3RJY7Y67HDFN7PIJBTYQC6KMRAXM57SC7Y2H546AAHFHWRH3YY";
      jest.mock("@stellar/freighter-api", () => ({
        isConnected: jest.fn().mockResolvedValue({ isConnected: true }),
        getAddress: jest.fn().mockResolvedValue({ address: mockAddress, error: null }),
      }));

      const publicKey = await adapter.connect();
      expect(publicKey).toBe(mockAddress);
    });

    it("connect throws when address is invalid", async () => {
      jest.mock("@stellar/freighter-api", () => ({
        isConnected: jest.fn().mockResolvedValue({ isConnected: true }),
        getAddress: jest.fn().mockResolvedValue({ address: "", error: "No address" }),
      }));

      await expect(adapter.connect()).rejects.toThrow("Failed to connect Freighter");
    });

    it("disconnect clears localStorage", async () => {
      localStorage.setItem("stellar_wallet_address", "test");
      localStorage.setItem("stellar_wallet_type", "freighter");
      await adapter.disconnect();
      expect(localStorage.getItem("stellar_wallet_address")).toBeNull();
      expect(localStorage.getItem("stellar_wallet_type")).toBeNull();
    });

    it("signTransaction returns signature hash", async () => {
      const mockTx = {
        toEnvelope: () => ({ toXDR: () => "base64xdr" }),
        networkPassphrase: "Test SDF Network ; September 2015",
      };
      (global as any).freighter = {
        signTransaction: jest.fn().mockResolvedValue({ hash: "txhash123" }),
      };

      const result = await adapter.signTransaction(mockTx);
      expect(result).toBe("txhash123");
    });

    it("signMessage returns signature", async () => {
      (global as any).freighter = {
        signMessage: jest.fn().mockResolvedValue({ signature: "sig123" }),
      };

      const result = await adapter.signMessage("hello");
      expect(result).toBe("sig123");
    });
  });

  describe("AlbedoAdapter", () => {
    let adapter: AlbedoAdapter;

    beforeEach(() => {
      adapter = new AlbedoAdapter();
    });

    it("has correct name and type", () => {
      expect(adapter.name).toBe("Albedo");
      expect(adapter.type).toBe("albedo");
    });

    it("isAvailable checks window.albedo", () => {
      (global as any).albedo = { publicKey: () => {} };
      expect(adapter.isAvailable()).toBe(true);
    });

    it("isAvailable returns false when albedo not present", () => {
      expect(adapter.isAvailable()).toBe(false);
    });

    it("connect returns publicKey from albedo", async () => {
      (global as any).albedo = {
        publicKey: jest.fn().mockResolvedValue({ publicKey: "testkey" }),
      };

      const result = await adapter.connect();
      expect(result).toBe("testkey");
    });

    it("connect throws when albedo not found", async () => {
      await expect(adapter.connect()).rejects.toThrow("Albedo wallet not found");
    });

    it("signTransaction returns hash", async () => {
      (global as any).albedo = {
        tx: jest.fn().mockResolvedValue({ hash: "albedohash" }),
      };

      const mockTx = { toEnvelope: () => ({ toXDR: () => "xdr" }) };
      const result = await adapter.signTransaction(mockTx);
      expect(result).toBe("albedohash");
    });

    it("signMessage returns signature", async () => {
      (global as any).albedo = {
        sign: jest.fn().mockResolvedValue({ signature: "alsig" }),
      };

      const result = await adapter.signMessage("msg");
      expect(result).toBe("alsig");
    });
  });

  describe("xBullAdapter", () => {
    let adapter: xBullAdapter;

    beforeEach(() => {
      adapter = new xBullAdapter();
    });

    it("has correct name and type", () => {
      expect(adapter.name).toBe("xBull");
      expect(adapter.type).toBe("xbull");
    });

    it("isAvailable checks window.xBull", () => {
      (global as any).xBull = { request: () => {} };
      expect(adapter.isAvailable()).toBe(true);
    });

    it("connect returns publicKey from xBull", async () => {
      (global as any).xBull = {
        requestPermissions: jest.fn().mockResolvedValue({ publicKey: "xbullkey" }),
      };

      const result = await adapter.connect();
      expect(result).toBe("xbullkey");
    });

    it("connect throws when xBull not found", async () => {
      await expect(adapter.connect()).rejects.toThrow("xBull wallet not found");
    });

    it("signTransaction returns result", async () => {
      (global as any).xBull = {
        request: jest.fn().mockResolvedValue({ result: "xbulltxhash" }),
      };

      const mockTx = { toEnvelope: () => ({ toXDR: () => "xdr" }), networkPassphrase: "test" };
      const result = await adapter.signTransaction(mockTx);
      expect(result).toBe("xbulltxhash");
    });

    it("signMessage returns signature", async () => {
      (global as any).xBull = {
        request: jest.fn().mockResolvedValue({ result: "xbullsig" }),
      };

      const result = await adapter.signMessage("msg");
      expect(result).toBe("xbullsig");
    });
  });

  describe("Adapter registry", () => {
    it("getAdapter returns correct adapter", () => {
      expect(getAdapter("freighter")?.name).toBe("Freighter");
      expect(getAdapter("albedo")?.name).toBe("Albedo");
      expect(getAdapter("xbull")?.name).toBe("xBull");
    });

    it("getAllAdapters returns all three adapters", () => {
      const adapters = getAllAdapters();
      expect(adapters).toHaveLength(3);
      expect(adapters.map((a) => a.type)).toEqual(["freighter", "albedo", "xbull"]);
    });

    it("getAdapter returns undefined for unknown type", () => {
      expect(getAdapter("unknown")).toBeUndefined();
    });
  });
});
