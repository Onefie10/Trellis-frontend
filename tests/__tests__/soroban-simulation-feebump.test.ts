import { SorobanContract, decodeSimulationError } from "../../lib/soroban/client";
import {
    invokeContractWithNotifications,
    buildFeeBumpTransactionIfNeeded,
    DEFAULT_FEE_BUMP_THRESHOLD
} from "../../lib/soroban/transactions-with-notifications";
import { invokeContract } from "../../lib/soroban/transactions";
import * as StellarSdk from "@stellar/stellar-sdk";

// Mock StellarSdk to support RPC, Horizon, and Fee Bump simulation
jest.mock("@stellar/stellar-sdk", () => {
    const original = jest.requireActual("@stellar/stellar-sdk");
    return {
        ...original,
        Horizon: {
            Server: jest.fn().mockImplementation(() => ({
                loadAccount: jest.fn().mockResolvedValue({
                    sequence: "1",
                    accountId: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                }),
            })),
        },
        rpc: {
            Server: jest.fn().mockImplementation(() => ({
                simulateTransaction: jest.fn().mockResolvedValue({
                    results: [{ xdr: "AAAAAgAAAAE=" }],
                    minResourceFee: "15000",
                    cost: { cpuInsns: "123456", memBytes: "65432" },
                    transactionData: {
                        resources: () => ({
                            readBytes: () => 1024,
                            writeBytes: () => 512,
                            footprint: () => ({
                                readOnly: () => ["entry1", "entry2"],
                                readWrite: () => ["entry3"],
                            }),
                        }),
                    },
                }),
                getTransaction: jest.fn().mockResolvedValue({ status: "SUCCESS" }),
            })),
            Api: {
                isSimulationSuccess: jest.fn().mockReturnValue(true),
                isSimulationError: jest.fn().mockReturnValue(false),
            },
            assembleTransaction: jest.fn().mockImplementation((tx) => ({
                build: jest.fn().mockReturnValue(tx),
            })),
        },
        Contract: jest.fn().mockImplementation(() => ({
            call: jest.fn().mockReturnValue({}),
        })),
        TransactionBuilder: {
            ...original.TransactionBuilder,
            buildFeeBumpTransaction: jest.fn().mockImplementation((feeSource, fee, innerTx, networkPassphrase) => ({
                feeSource,
                fee,
                innerTx,
                networkPassphrase,
                toEnvelopeXdr: jest.fn().mockReturnValue("FEE_BUMP_ENVELOPE_XDR"),
                isFeeBump: true,
            })),
        },
    };
});

jest.mock("../../lib/notifications", () => ({
    notificationManager: {
        showTransactionNotification: jest.fn().mockResolvedValue(undefined),
        showTradeNotification: jest.fn().mockResolvedValue(undefined),
    },
}));

describe("Soroban Simulation & Fee Bump Envelope", () => {
    let contract: SorobanContract;
    const dummyPublicKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    beforeEach(() => {
        jest.clearAllMocks();
        contract = new SorobanContract("CCONTRACT123", "testnet");
    });

    describe("Error Decoding", () => {
        it("decodes top-level error strings", () => {
            const err = decodeSimulationError({ error: "Host function error" });
            expect(err).toBe("Host function error");
        });

        it("decodes error from results array", () => {
            const err = decodeSimulationError({ results: [{ error: "Error in contract invocation" }] });
            expect(err).toBe("Error in contract invocation");
        });

        it("decodes fallback XDR error", () => {
            const err = decodeSimulationError({ results: [{ xdr: "AAAAA123" }] });
            expect(err).toContain("XDR: AAAAA123");
        });

        it("handles null or empty response", () => {
            expect(decodeSimulationError(null)).toBe("Unknown simulation error");
        });
    });

    describe("Pre-flight Simulation and Resource Estimation", () => {
        it("executes simulateTransaction and extracts CPU, RAM, and ledger resources", async () => {
            const sim = await contract.simulateTransaction("transfer", [100], dummyPublicKey);

            expect(sim.metrics.cpuInstructions).toBe(123456);
            expect(sim.metrics.ramBytes).toBe(65432);
            expect(sim.metrics.ledgerReadBytes).toBe(1024);
            expect(sim.metrics.ledgerWriteBytes).toBe(512);
            expect(sim.metrics.readCount).toBe(2);
            expect(sim.metrics.writeCount).toBe(1);
            expect(sim.minResourceFee).toBe(15000);
        });

        it("throws decoded error when pre-flight simulation fails", async () => {
            const { rpc }: any = StellarSdk;
            rpc.Api.isSimulationSuccess.mockReturnValueOnce(false);
            rpc.Server.mockImplementationOnce(() => ({
                simulateTransaction: jest.fn().mockResolvedValue({
                    error: "Resource limit exceeded",
                }),
            }));

            const failingContract = new SorobanContract("CCONTRACT123", "testnet");
            await expect(failingContract.simulateTransaction("transfer", [100], dummyPublicKey))
                .rejects.toThrow("Simulation failed: Resource limit exceeded");
        });
    });

    describe("Fee Bump Transaction Wrapper", () => {
        it("constructs a Fee Bump envelope when minResourceFee exceeds threshold", () => {
            const innerTx = new StellarSdk.TransactionBuilder(
                new StellarSdk.Account(dummyPublicKey, "1"),
                { fee: "100", networkPassphrase: "Test SDF Network ; July 2015" }
            )
                .setTimeout(0)
                .build();

            const result = buildFeeBumpTransactionIfNeeded(
                innerTx,
                dummyPublicKey,
                15000, // minResourceFee > 10000 default threshold
                "Test SDF Network ; July 2015"
            );

            expect(result.isFeeBumped).toBe(true);
            expect(StellarSdk.TransactionBuilder.buildFeeBumpTransaction).toHaveBeenCalledWith(
                dummyPublicKey,
                "30000", // max(100*2, 15000*2, 20000)
                innerTx,
                "Test SDF Network ; July 2015"
            );
        });

        it("does NOT wrap in Fee Bump envelope when base fee is below threshold", () => {
            const innerTx = new StellarSdk.TransactionBuilder(
                new StellarSdk.Account(dummyPublicKey, "1"),
                { fee: "100", networkPassphrase: "Test SDF Network ; July 2015" }
            )
                .setTimeout(0)
                .build();

            const result = buildFeeBumpTransactionIfNeeded(
                innerTx,
                dummyPublicKey,
                500, // minResourceFee < 10000 threshold
                "Test SDF Network ; July 2015"
            );

            expect(result.isFeeBumped).toBe(false);
        });
    });

    describe("invokeContractWithNotifications integration", () => {
        it("runs pre-flight simulation and wraps in Fee Bump envelope when base fee surges", async () => {
            const signCallback = jest.fn().mockResolvedValue({
                success: true,
                hash: "0x1234567890abcdef",
            });

            const result = await invokeContractWithNotifications(
                contract,
                "transfer",
                [100],
                dummyPublicKey,
                signCallback,
                { feeBumpThreshold: 10000 }
            );

            expect(result.success).toBe(true);
            expect(result.hash).toBe("0x1234567890abcdef");
            expect(result.isFeeBumped).toBe(true);
            expect(result.metrics?.cpuInstructions).toBe(123456);
            expect(signCallback).toHaveBeenCalled();
        });

        it("handles pre-flight simulation failure gracefully before wallet approval", async () => {
            const { rpc }: any = StellarSdk;
            rpc.Api.isSimulationSuccess.mockReturnValueOnce(false);
            rpc.Server.mockImplementationOnce(() => ({
                simulateTransaction: jest.fn().mockResolvedValue({
                    error: "Insufficient funds for gas",
                }),
            }));

            const signCallback = jest.fn();

            const result = await invokeContractWithNotifications(
                contract,
                "transfer",
                [100],
                dummyPublicKey,
                signCallback
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("Insufficient funds for gas");
            expect(signCallback).not.toHaveBeenCalled();
        });
    });
});
