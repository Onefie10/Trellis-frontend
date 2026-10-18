import * as StellarSdk from "@stellar/stellar-sdk";
import { SorobanContract, decodeSimulationError } from "./client";
import { SorobanTransactionResult, ResourceMetrics } from "../types";
import { STELLAR_NETWORKS } from "../stellar-constants";
import { notificationManager } from "../notifications";

export const DEFAULT_FEE_BUMP_THRESHOLD = 10000; // Stroops threshold for base fee spike fee bump envelope

export interface TransactionNotificationOptions {
  description?: string;
  agentName?: string;
  amount?: string;
  type?: 'trade' | 'transaction' | 'general';
  showNotification?: boolean;
  feeBumpThreshold?: number;
  feeSource?: string;
  maxFee?: number | string;
  forceFeeBump?: boolean;
}

/**
 * Builds a Fee Bump transaction envelope if minResourceFee or network base fee exceeds threshold
 */
export function buildFeeBumpTransactionIfNeeded(
    transaction: StellarSdk.Transaction,
    publicKey: string,
    minResourceFee: number,
    networkPassphrase: string,
    options: TransactionNotificationOptions = {}
): { transaction: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction; isFeeBumped: boolean } {
    const threshold = options.feeBumpThreshold ?? DEFAULT_FEE_BUMP_THRESHOLD;
    const forceFeeBump = options.forceFeeBump ?? false;

    if (minResourceFee >= threshold || forceFeeBump) {
        const feeSource = options.feeSource || publicKey;
        const innerFee = Number(transaction.fee || 100);
        const feeToUse = options.maxFee 
            ? String(options.maxFee) 
            : String(Math.max(innerFee * 2, minResourceFee * 2, 20000));

        const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
            feeSource,
            feeToUse,
            transaction,
            networkPassphrase
        );

        return { transaction: feeBumpTx, isFeeBumped: true };
    }

    return { transaction, isFeeBumped: false };
}

/**
 * Enhanced transaction wrapper with pre-flight simulation and Fee Bump envelope support
 */
export async function invokeContractWithNotifications(
    contract: SorobanContract,
    functionName: string,
    args: any[],
    publicKey: string,
    signCallback: (tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction) => Promise<{ success: boolean; hash?: string; error?: string }>,
    notificationOptions: TransactionNotificationOptions = {}
): Promise<SorobanTransactionResult> {
    const {
        description,
        agentName,
        amount,
        type = 'transaction',
        showNotification = true
    } = notificationOptions;

    try {
        // 1. Pre-flight contract simulation call to validate execution and estimate required Soroban resources
        let simResult;
        try {
            simResult = await contract.simulateTransaction(functionName, args, publicKey);
        } catch (simError: any) {
            const errorResult: SorobanTransactionResult = {
                success: false,
                error: simError.message || "Pre-flight contract simulation failed",
            };
            if (showNotification) {
                await showTransactionNotification(errorResult, description, type, agentName, amount);
            }
            return errorResult;
        }

        const { transaction: innerTx, metrics, minResourceFee } = simResult;

        // 2. Build Fee Bump transaction envelope when network base fee spikes / exceeds threshold
        const networkConfig = STELLAR_NETWORKS[contract.network];
        const { transaction: txToSign, isFeeBumped } = buildFeeBumpTransactionIfNeeded(
            innerTx,
            publicKey,
            minResourceFee,
            networkConfig.networkPassphrase,
            notificationOptions
        );

        // 3. User Wallet Approval & Signing
        const signResult = await signCallback(txToSign);
        if (!signResult.success) {
            const errorResult: SorobanTransactionResult = {
                success: false,
                error: signResult.error || "User rejected signing",
                metrics,
                isFeeBumped
            };
            
            // Show notification for signing failure if enabled
            if (showNotification) {
                await showTransactionNotification(errorResult, description, type, agentName, amount);
            }
            
            return errorResult;
        }

        // 4. Submit & Poll status
        const rpcUrl = networkConfig.rpcUrl ||
            networkConfig.horizonUrl.replace("horizon", "soroban-rpc");
        const server = new (StellarSdk as any).rpc.Server(rpcUrl);

        if (signResult.hash) {
            const waitResult = await pollTransactionStatus(server, signResult.hash);
            const result: SorobanTransactionResult = {
                success: waitResult.status === "SUCCESS",
                hash: signResult.hash,
                metrics,
                isFeeBumped,
                error: waitResult.error,
            };

            // Show notification based on result
            if (showNotification) {
                await showTransactionNotification(result, description, type, agentName, amount);
            }

            return result;
        }

        const errorResult: SorobanTransactionResult = {
            success: false,
            error: "Failed to obtain transaction hash",
            metrics,
            isFeeBumped
        };
        
        // Show notification for hash failure if enabled
        if (showNotification) {
            await showTransactionNotification(errorResult, description, type, agentName, amount);
        }

        return errorResult;
    } catch (error: any) {
        console.error("Invoke Error:", error);
        const errorResult: SorobanTransactionResult = {
            success: false,
            error: error.message || "Unknown error during invocation"
        };
        
        // Show notification for exception if enabled
        if (showNotification) {
            await showTransactionNotification(errorResult, description, type, agentName, amount);
        }
        
        return errorResult;
    }
}

/**
 * Show appropriate notification based on transaction result and type
 */
async function showTransactionNotification(
    result: SorobanTransactionResult,
    description: string | undefined,
    type: 'trade' | 'transaction' | 'general',
    agentName: string | undefined,
    amount: string | undefined
): Promise<void> {
    if (type === 'trade' && agentName) {
        await notificationManager.showTradeNotification(result, agentName, amount);
    } else {
        const notificationDescription = description || 
            (result.success ? 'Transaction completed successfully' : 'Transaction failed');
        await notificationManager.showTransactionNotification(result, notificationDescription);
    }
}

/**
 * Poll for transaction completion with exponential backoff
 */
export async function pollTransactionStatus(
    server: any,
    hash: string,
    maxAttempts = 10,
    initialDelay = 1000
): Promise<{ status: string; error?: string }> {
    let delay = initialDelay;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const statusResponse = await server.getTransaction(hash);

            if (statusResponse.status === "SUCCESS") {
                return { status: "SUCCESS" };
            } else if (statusResponse.status === "FAILED") {
                return { status: "FAILED", error: "Transaction failed on-chain" };
            }

            // Still pending
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 1.5; // Exponential backoff
        } catch (e) {
            // Ignore network errors during polling and retry
        }
    }

    return { status: "TIMEOUT", error: "Transaction polling timed out" };
}

/**
 * Trade-specific transaction wrapper
 */
export async function executeTrade(
    contract: SorobanContract,
    functionName: string,
    args: any[],
    publicKey: string,
    signCallback: (tx: StellarSdk.Transaction) => Promise<{ success: boolean; hash?: string; error?: string }>,
    agentName: string,
    amount?: string
): Promise<SorobanTransactionResult> {
    return await invokeContractWithNotifications(
        contract,
        functionName,
        args,
        publicKey,
        signCallback,
        {
            description: `Trade execution for ${agentName}`,
            agentName,
            amount,
            type: 'trade',
            showNotification: true
        }
    );
}

/**
 * General transaction wrapper
 */
export async function executeTransaction(
    contract: SorobanContract,
    functionName: string,
    args: any[],
    publicKey: string,
    signCallback: (tx: StellarSdk.Transaction) => Promise<{ success: boolean; hash?: string; error?: string }>,
    description?: string
): Promise<SorobanTransactionResult> {
    return await invokeContractWithNotifications(
        contract,
        functionName,
        args,
        publicKey,
        signCallback,
        {
            description,
            type: 'transaction',
            showNotification: true
        }
    );
}

/**
 * Silent transaction wrapper (no notifications)
 */
export async function executeSilentTransaction(
    contract: SorobanContract,
    functionName: string,
    args: any[],
    publicKey: string,
    signCallback: (tx: StellarSdk.Transaction) => Promise<{ success: boolean; hash?: string; error?: string }>
): Promise<SorobanTransactionResult> {
    return await invokeContractWithNotifications(
        contract,
        functionName,
        args,
        publicKey,
        signCallback,
        {
            showNotification: false
        }
    );
}
