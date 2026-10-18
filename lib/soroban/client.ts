import * as StellarSdk from "@stellar/stellar-sdk";
import {
    RpcConnectionStatusInfo,
    StellarNetwork,
    SorobanContractSpec,
    ResourceMetrics,
    SorobanTransactionResult,
} from "../types";
import { STELLAR_NETWORKS, SOROBAN_RPC_CONFIG } from "../stellar-constants";
import { specLoader } from "./spec";
import { serializeSorobanValue } from "./values";

export function getRpcUrls(network: StellarNetwork, overrideUrls?: string[]): string[] {
    const config = STELLAR_NETWORKS[network];
    const primaryUrl = config.rpcUrl || config.horizonUrl.replace("horizon", "soroban-rpc");
    const fallbackUrls = [...(config.rpcFallbackUrls || []), ...(overrideUrls || [])];

    return [...new Set([primaryUrl, ...fallbackUrls].filter(Boolean))];
}

export function getSorobanRpcPoolManager(network: StellarNetwork, overrideUrls?: string[]): SorobanRpcPoolManager {
    return SorobanRpcPoolManager.getInstance(network, overrideUrls);
}

export class SorobanRpcPoolManager {
    static instances: Map<StellarNetwork, SorobanRpcPoolManager> = new Map();

    private readonly rpcUrls: string[];
    private readonly servers: any[];
    private activeIndex = 0;
    private status: RpcConnectionStatusInfo = {
        status: "connected",
        activeNode: null,
        fallbackNodes: 0,
        latencyMs: 0,
    };

    constructor(private readonly network: StellarNetwork, overrideUrls?: string[]) {
        this.rpcUrls = getRpcUrls(network, overrideUrls);
        this.servers = this.rpcUrls.map((url) => new (StellarSdk as any).rpc.Server(url));
        this.status.activeNode = this.rpcUrls[0] || null;
        this.status.fallbackNodes = Math.max(this.rpcUrls.length - 1, 0);
    }

    static getInstance(network: StellarNetwork, overrideUrls?: string[]): SorobanRpcPoolManager {
        let instance = SorobanRpcPoolManager.instances.get(network);
        if (!instance) {
            instance = new SorobanRpcPoolManager(network, overrideUrls);
            SorobanRpcPoolManager.instances.set(network, instance);
        }
        return instance;
    }

    getStatus(): RpcConnectionStatusInfo {
        return {
            ...this.status,
            activeNode: this.rpcUrls[this.activeIndex] || this.status.activeNode,
            fallbackNodes: Math.max(this.rpcUrls.length - 1, 0),
        };
    }

    getActiveServer(): any {
        return this.servers[this.activeIndex] || this.servers[0];
    }

    private rotateToNextNode(): boolean {
        if (this.rpcUrls.length <= 1) {
            return false;
        }

        this.activeIndex = (this.activeIndex + 1) % this.rpcUrls.length;
        this.status.activeNode = this.rpcUrls[this.activeIndex] || null;
        return true;
    }

    private summarizeError(error: any): { retryable: boolean; shouldFailover: boolean } {
        const code = Number(error?.response?.status ?? error?.status ?? error?.code ?? 0);
        const message = `${error?.message || ""} ${error?.response?.statusText || ""} ${JSON.stringify(error?.response || {})}`.toLowerCase();
        const retryable =
            code === 429 ||
            code >= 500 ||
            /429|rate limit|too many requests|failed to fetch|networkerror|timeout|timed out|internal server error|service unavailable|gateway timeout/i.test(message);

        return {
            retryable,
            shouldFailover: retryable && this.rpcUrls.length > 1,
        };
    }

    private shouldProbeNodeLatencies(): boolean {
        return typeof window !== "undefined" || this.rpcUrls.length > 1;
    }

    private async wait(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private getBackoffDelay(attempt: number): number {
        const exponential = SOROBAN_RPC_CONFIG.baseBackoffMs * Math.pow(2, attempt);
        const jitter = Math.random() * SOROBAN_RPC_CONFIG.baseBackoffMs;
        return Math.min(exponential + jitter, 8000);
    }

    async refreshNodeHealth(): Promise<boolean> {
        const server = this.getActiveServer();
        if (!server || typeof server.getHealth !== "function") {
            return true;
        }

        try {
            const startedAt = Date.now();
            await Promise.race([
                server.getHealth(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("RPC health check timed out")), Math.max(SOROBAN_RPC_CONFIG.latencyThresholdMs * 2, 5000))),
            ]);

            const latencyMs = Date.now() - startedAt;
            this.status.latencyMs = latencyMs;
            this.status.activeNode = this.rpcUrls[this.activeIndex] || null;

            if (latencyMs > SOROBAN_RPC_CONFIG.latencyThresholdMs) {
                this.status.status = "degraded";
                this.status.warning = `RPC latency above ${SOROBAN_RPC_CONFIG.latencyThresholdMs}ms`;
                this.status.lastError = undefined;
                if (this.rpcUrls.length > 1) {
                    this.rotateToNextNode();
                }
                return false;
            }

            this.status.status = "connected";
            this.status.warning = undefined;
            this.status.lastError = undefined;
            return true;
        } catch (error: any) {
            this.status.status = "offline";
            this.status.warning = "RPC node is unhealthy";
            this.status.lastError = error?.message || "Soroban RPC health check failed";
            if (this.rpcUrls.length > 1) {
                this.rotateToNextNode();
            }
            return false;
        }
    }

    async executeWithRetry<T>(operation: (server: any) => Promise<T>): Promise<T> {
        let lastError: any;

        for (let attempt = 0; attempt <= SOROBAN_RPC_CONFIG.maxRetries; attempt += 1) {
            const server = this.getActiveServer();

            try {
                if (this.shouldProbeNodeLatencies()) {
                    const healthCheckPassed = await this.refreshNodeHealth();
                    if (!healthCheckPassed && this.rpcUrls.length > 1) {
                        continue;
                    }
                }

                const startedAt = Date.now();
                const result = await operation(server);
                const elapsedMs = Date.now() - startedAt;
                this.status.latencyMs = elapsedMs;
                if (elapsedMs > SOROBAN_RPC_CONFIG.latencyThresholdMs) {
                    this.status.status = "degraded";
                    this.status.warning = `RPC latency above ${SOROBAN_RPC_CONFIG.latencyThresholdMs}ms`;
                    this.status.lastError = undefined;
                    if (this.rpcUrls.length > 1) {
                        this.rotateToNextNode();
                    }
                    return result;
                }

                this.status.status = "connected";
                this.status.activeNode = this.rpcUrls[this.activeIndex] || null;
                this.status.warning = undefined;
                this.status.lastError = undefined;

                return result;
            } catch (error: any) {
                lastError = error;
                const { retryable, shouldFailover } = this.summarizeError(error);

                this.status.lastError = error?.message || "Soroban RPC request failed";
                this.status.warning = retryable ? "Retrying with a fallback RPC node" : "Soroban RPC request failed";

                if (retryable && attempt < SOROBAN_RPC_CONFIG.maxRetries) {
                    if (shouldFailover) {
                        this.rotateToNextNode();
                    }
                    this.status.status = this.rpcUrls.length > 1 ? "degraded" : "offline";
                    await this.wait(this.getBackoffDelay(attempt));
                    continue;
                }

                if (shouldFailover) {
                    this.rotateToNextNode();
                    this.status.status = "degraded";
                } else {
                    this.status.status = "offline";
                }

                throw error;
            }
        }

        throw lastError || new Error("Soroban RPC call failed without a response");
    }
}

/**
 * Robust Soroban contract interaction client
 */
export class SorobanContract {
    private rpcPool: SorobanRpcPoolManager;
    private server: any;
    private networkPassphrase: string;
    private contract: StellarSdk.Contract;

    constructor(
        public readonly contractId: string,
        public readonly network: StellarNetwork,
        public readonly spec?: SorobanContractSpec
    ) {
        const config = STELLAR_NETWORKS[network];
        this.rpcPool = SorobanRpcPoolManager.getInstance(network);
        this.server = this.rpcPool.getActiveServer();
        this.networkPassphrase = config.networkPassphrase;
        this.contract = new StellarSdk.Contract(contractId);
    }

    /**
     * Simulate a contract call (Read-only)
     */
    async callReadOnly(
        functionName: string,
        args: any[] = []
    ): Promise<{ result: any; metrics: ResourceMetrics }> {
        try {
            const dummyAccount = new StellarSdk.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");

            const tx = new StellarSdk.TransactionBuilder(dummyAccount, {
                fee: "100",
                networkPassphrase: this.networkPassphrase,
            })
                .addOperation(this.contract.call(functionName, ...this.prepareArgs(functionName, args)))
                .setTimeout(StellarSdk.TimeoutInfinite)
                .build();

            const response = await this.rpcPool.executeWithRetry((server) => server.simulateTransaction(tx));

            if ((StellarSdk as any).rpc.Api.isSimulationSuccess(response)) {
                const result = response.results[0];
                const scValResult = StellarSdk.xdr.ScVal.fromXDR(result.xdr, "base64");

                return {
                    result: StellarSdk.scValToNative(scValResult),
                    metrics: this.extractMetrics(response),
                };
            }

            throw new Error(`Simulation failed: ${JSON.stringify(response)}`);
        } catch (error) {
            console.error(`Error in callReadOnly (${functionName}):`, error);
            throw error;
        }
    }

    /**
     * Pre-flight contract transaction simulation to validate execution and estimate resources
     */
    async simulateTransaction(
        functionName: string,
        args: any[],
        publicKey: string
    ): Promise<{
        transaction: StellarSdk.Transaction;
        metrics: ResourceMetrics;
        simulationResponse: any;
        minResourceFee: number;
    }> {
        try {
            const server = new StellarSdk.Horizon.Server(STELLAR_NETWORKS[this.network].horizonUrl);
            const account = await server.loadAccount(publicKey);

            let tx = new StellarSdk.TransactionBuilder(account, {
                fee: "100",
                networkPassphrase: this.networkPassphrase,
            })
                .addOperation(this.contract.call(functionName, ...this.prepareArgs(functionName, args)))
                .setTimeout(StellarSdk.TimeoutInfinite)
                .build();

            const simulationResponse = await this.rpcPool.executeWithRetry((rpcServer) => rpcServer.simulateTransaction(tx));

            if (!(StellarSdk as any).rpc.Api.isSimulationSuccess(simulationResponse)) {
                const errorMsg = decodeSimulationError(simulationResponse);
                throw new Error(`Simulation failed: ${errorMsg}`);
            }

            tx = (StellarSdk as any).rpc.assembleTransaction(tx, simulationResponse).build();
            const metrics = this.extractMetrics(simulationResponse);
            const minResourceFee = Number(simulationResponse.minResourceFee || 0);

            return {
                transaction: tx,
                metrics,
                simulationResponse,
                minResourceFee,
            };
        } catch (error) {
            console.error(`Error in simulateTransaction (${functionName}):`, error);
            throw error;
        }
    }

    /**
     * Prepare a transaction for invocation (State-changing)
     */
    async prepareInvoke(
        functionName: string,
        args: any[],
        publicKey: string
    ): Promise<{ transaction: StellarSdk.Transaction; metrics: ResourceMetrics; minResourceFee?: number }> {
        const result = await this.simulateTransaction(functionName, args, publicKey);
        return {
            transaction: result.transaction,
            metrics: result.metrics,
            minResourceFee: result.minResourceFee,
        };
    }

    /**
     * Helper to extract resource metrics from simulation response
     */
    public extractMetrics(response: any): ResourceMetrics {
        const minFee = Number(response?.minResourceFee || 0);
        const cost = response?.cost || {};

        let ledgerReadBytes = 0;
        let ledgerWriteBytes = 0;
        let readCount = 0;
        let writeCount = 0;

        try {
            let txData = response?.transactionData;
            if (typeof txData === "string" && (StellarSdk as any).xdr?.SorobanTransactionData) {
                try {
                    txData = (StellarSdk as any).xdr.SorobanTransactionData.fromXDR(txData, "base64");
                } catch {
                    // Ignore decoding error if mock or invalid XDR
                }
            }

            if (txData && typeof txData.resources === "function") {
                const res = txData.resources();
                if (res) {
                    if (typeof res.readBytes === "function") ledgerReadBytes = Number(res.readBytes());
                    if (typeof res.writeBytes === "function") ledgerWriteBytes = Number(res.writeBytes());
                    const footprint = typeof res.footprint === "function" ? res.footprint() : null;
                    if (footprint) {
                        if (typeof footprint.readOnly === "function") readCount = footprint.readOnly().length;
                        if (typeof footprint.readWrite === "function") writeCount = footprint.readWrite().length;
                    }
                }
            } else if (txData && txData.resources) {
                const res = txData.resources;
                ledgerReadBytes = Number(res.readBytes || 0);
                ledgerWriteBytes = Number(res.writeBytes || 0);
                if (res.footprint) {
                    readCount = res.footprint.readOnly?.length || 0;
                    writeCount = res.footprint.readWrite?.length || 0;
                }
            }
        } catch (e) {
            // Fallback gracefully on parsing errors
        }

        return {
            cpuInstructions: Number(cost.cpuInsns || 0),
            ramBytes: Number(cost.memBytes || 0),
            ledgerReadBytes: 0,
            ledgerWriteBytes: 0,
            readCount: 0,
            writeCount: 0,
            costXlm: (minFee / 10000000).toFixed(7),
            minResourceFee: String(minFee),
        };
    }

    /**
     * Internal helper to map args based on spec (if available) or native conversion
     */
    private prepareArgs(functionName: string, args: any[]): StellarSdk.xdr.ScVal[] {
        const fn = this.spec?.fns.find((candidate) => candidate.name === functionName);
        if (fn && fn.args.length === args.length) {
            return fn.args.map((arg, index) => serializeSorobanValue(arg.type, args[index]));
        }
        return args.map(arg => StellarSdk.nativeToScVal(arg));
    }
}

/**
 * Decodes simulation error response from Soroban RPC into a human-readable string
 */
export function decodeSimulationError(response: any): string {
    if (!response) return "Unknown simulation error";
    if (typeof response === "string") return response;
    if (response.error) {
        return typeof response.error === "string" ? response.error : JSON.stringify(response.error);
    }
    if (Array.isArray(response.results) && response.results.length > 0) {
        const first = response.results[0];
        if (first.error) {
            return typeof first.error === "string" ? first.error : JSON.stringify(first.error);
        }
        if (first.xdr) {
            return `Contract execution error (XDR: ${first.xdr})`;
        }
    }
    return "Transaction simulation failed pre-flight check";
}

/**
 * Factory class for managing Soroban contract instances
 */
export class SorobanContractFactory {
    private instances: Map<string, SorobanContract> = new Map();

    constructor(private network: StellarNetwork) { }

    async getContract(contractId: string, specJson?: any): Promise<SorobanContract> {
        const key = `${this.network}:${contractId}`;
        if (this.instances.has(key)) {
            return this.instances.get(key)!;
        }

        let spec: SorobanContractSpec | undefined;
        if (specJson) {
            spec = await specLoader.loadFromJson(contractId, specJson);
        }

        const instance = new SorobanContract(contractId, this.network, spec);
        this.instances.set(key, instance);
        return instance;
    }
}
