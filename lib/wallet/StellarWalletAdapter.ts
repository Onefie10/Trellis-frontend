export interface StellarWalletAdapter {
  readonly name: string;
  readonly type: string;
  readonly icon?: string;
  isAvailable(): boolean | Promise<boolean>;
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  signTransaction(transaction: any): Promise<string>;
  signMessage(message: string): Promise<string>;
}

export class FreighterAdapter implements StellarWalletAdapter {
  readonly name = "Freighter";
  readonly type = "freighter";
  readonly icon = "🚢";

  async isAvailable(): Promise<boolean> {
    try {
      const { isConnected } = await import("@stellar/freighter-api");
      const status = await isConnected();
      return status.isConnected;
    } catch {
      return false;
    }
  }

  async connect(): Promise<string> {
    const { getAddress } = await import("@stellar/freighter-api");
    const { address, error } = await getAddress();
    if (error || !address) {
      throw new Error(error || "Failed to connect Freighter");
    }
    return address;
  }

  async disconnect(): Promise<void> {
    if (typeof window !== "undefined") {
      localStorage.removeItem("stellar_wallet_address");
      localStorage.removeItem("stellar_wallet_type");
    }
  }

  async signTransaction(transaction: any): Promise<string> {
    const xdr = transaction.toEnvelope().toXDR("base64");
    const freighter = (window as any).freighter;
    const response = await freighter.signTransaction(xdr, {
      networkPassphrase: transaction.networkPassphrase,
    });
    if (response.error) {
      throw new Error(response.error.message || "Failed to sign transaction");
    }
    return response.hash;
  }

  async signMessage(message: string): Promise<string> {
    const freighter = (window as any).freighter;
    const response = await freighter.signMessage(message);
    if (response.error) {
      throw new Error(response.error.message || "Failed to sign message");
    }
    return response.signature;
  }
}

export class AlbedoAdapter implements StellarWalletAdapter {
  readonly name = "Albedo";
  readonly type = "albedo";
  readonly icon = "🔭";

  isAvailable(): boolean {
    return typeof window !== "undefined" && !!(window as any).albedo;
  }

  async connect(): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error("Albedo wallet not found");
    }
    const response = await (window as any).albedo.publicKey();
    if (!response.publicKey) {
      throw new Error("Failed to get address from Albedo");
    }
    return response.publicKey;
  }

  async disconnect(): Promise<void> {
    if (typeof window !== "undefined") {
      localStorage.removeItem("stellar_wallet_address");
      localStorage.removeItem("stellar_wallet_type");
    }
  }

  async signTransaction(transaction: any): Promise<string> {
    const xdr = transaction.toEnvelope().toXDR("base64");
    const response = await (window as any).albedo.tx({ xdr });
    if (response.error) {
      throw new Error(response.error);
    }
    return response.hash;
  }

  async signMessage(message: string): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error("Albedo wallet not found");
    }
    const response = await (window as any).albedo.sign({ message });
    if (response.error) {
      throw new Error(response.error);
    }
    return response.signature;
  }
}

export class xBullAdapter implements StellarWalletAdapter {
  readonly name = "xBull";
  readonly type = "xbull";
  readonly icon = "🐂";

  isAvailable(): boolean {
    return typeof window !== "undefined" && !!(window as any).xBull;
  }

  async connect(): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error("xBull wallet not found");
    }
    const xbull = (window as any).xBull;
    const response = await xbull.requestPermissions({
      methods: ["stellar_signTransaction", "stellar_signMessage"],
    });
    if (!response || !response.publicKey) {
      throw new Error("Failed to connect xBull");
    }
    return response.publicKey;
  }

  async disconnect(): Promise<void> {
    if (typeof window !== "undefined") {
      localStorage.removeItem("stellar_wallet_address");
      localStorage.removeItem("stellar_wallet_type");
    }
  }

  async signTransaction(transaction: any): Promise<string> {
    const xbull = (window as any).xBull;
    const xdr = transaction.toEnvelope().toXDR("base64");
    const response = await xbull.request({
      method: "stellar_signTransaction",
      params: { xdr, networkPassphrase: transaction.networkPassphrase },
    });
    if (response.error) {
      throw new Error(response.error);
    }
    return response.result;
  }

  async signMessage(message: string): Promise<string> {
    const xbull = (window as any).xBull;
    const response = await xbull.request({
      method: "stellar_signMessage",
      params: { message },
    });
    if (response.error) {
      throw new Error(response.error);
    }
    return response.result;
  }
}

const ADAPTERS: Record<string, StellarWalletAdapter> = {
  freighter: new FreighterAdapter(),
  albedo: new AlbedoAdapter(),
  xbull: new xBullAdapter(),
};

export function getAdapter(type: string): StellarWalletAdapter | undefined {
  return ADAPTERS[type];
}

export function getAllAdapters(): StellarWalletAdapter[] {
  return Object.values(ADAPTERS);
}

export function isAdapterAvailable(type: string): boolean | Promise<boolean> {
  const adapter = ADAPTERS[type];
  if (!adapter) return false;
  return adapter.isAvailable();
}
