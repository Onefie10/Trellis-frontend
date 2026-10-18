import * as StellarSdk from "@stellar/stellar-sdk";
import { SorobanContract } from "./client";
import { SorobanTransactionResult, ResourceMetrics } from "../types";
import { STELLAR_NETWORKS } from "../stellar-constants";

import { buildFeeBumpTransactionIfNeeded, TransactionNotificationOptions } from "./transactions-with-notifications";

/**
 * High-level wrapper for Soroban state-changing calls with simulation pre-flight and Fee Bump support
 */
export async function invokeContract(
    contract: SorobanContract,
    functionName: string,
    args: any[],
    publicKey: string,
    signCallback: (tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction) => Promise<{ success: boolean; hash?: string; error?: string }>,
    options: TransactionNotificationOptions = {}
): Promise<SorobanTransactionResult> {
    try {
        // 1. Prepare and simulate pre-flight
        const simResult = await contract.simulateTransaction(functionName, args, publicKey);
        const { transaction: innerTx, metrics, minResourceFee } = simResult;

        // 2. Fee Bump envelope construction when base fee exceeds threshold
        const networkConfig = STELLAR_NETWORKS[contract.network];
        const { transaction: txToSign, isFeeBumped } = buildFeeBumpTransactionIfNeeded(
            innerTx,
            publicKey,
            minResourceFee,
            networkConfig.networkPassphrase,
            options
        );

        // 3. Sign
        const signResult = await signCallback(txToSign);
        if (!signResult.success) {
            return { success: false, error: signResult.error || "User rejected signing", metrics, isFeeBumped };
        }

        // 4. Submit & Poll
        const rpcUrl = networkConfig.rpcUrl ||
            networkConfig.horizonUrl.replace("horizon", "soroban-rpc");
        const server = new (StellarSdk as any).rpc.Server(rpcUrl);

        if (signResult.hash) {
            const waitResult = await pollTransactionStatus(server, signResult.hash);
            return {
                success: waitResult.status === "SUCCESS",
                hash: signResult.hash,
                metrics,
                isFeeBumped,
                error: waitResult.error,
            };
        }

        return { success: false, error: "Failed to obtain transaction hash", metrics, isFeeBumped };
    } catch (error: any) {
        console.error("Invoke Error:", error);
        return { success: false, error: error.message || "Unknown error during invocation" };
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
 * Submits an aggregated multi-signature transaction to Soroban RPC once threshold signatures are met
 */
export async function submitMultisigTransaction(
    envelopeXdr: string,
    networkName: string = "TESTNET"
): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
        const netKey = (networkName.toUpperCase() in STELLAR_NETWORKS)
            ? networkName.toUpperCase() as keyof typeof STELLAR_NETWORKS
            : "TESTNET";
        const networkConfig = STELLAR_NETWORKS[netKey];
        const rpcUrl = networkConfig.rpcUrl || networkConfig.horizonUrl.replace("horizon", "soroban-rpc");
        const server = new (StellarSdk as any).rpc.Server(rpcUrl);
        const tx = StellarSdk.TransactionBuilder.fromXDR(envelopeXdr, networkConfig.networkPassphrase);
        const sendResponse = await server.sendTransaction(tx);
        if (sendResponse.status === "ERROR") {
            return {
                success: false,
                error: (sendResponse as any).errorResult?.message || "Failed to submit transaction to Soroban RPC",
            };
        }
        if (sendResponse.hash) {
            const waitResult = await pollTransactionStatus(server, sendResponse.hash);
            return {
                success: waitResult.status === "SUCCESS",
                hash: sendResponse.hash,
                error: waitResult.error,
            };
        }
        return { success: false, error: "No transaction hash returned" };
    } catch (e: any) {
        return { success: false, error: e.message || "Failed to submit multisig transaction" };
    }
}

