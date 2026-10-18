/**
 * Trellis Cross-Repo Integration Contract
 * 
 * This file defines the shared types for core operations, statuses, errors, 
 * and receipts used across Trellis repositories (Frontend, API, Smart Contracts).
 * 
 * DO NOT INTRODUCE BREAKING CHANGES WITHOUT COORDINATION.
 * Refer to docs/CROSS_REPO_CONTRACTS.md for the update workflow.
 */

/**
 * Supported core operation types within the Trellis protocol.
 */
export enum TrellisOperationType {
  DEPOSIT = 'DEPOSIT',
  WITHDRAW = 'WITHDRAW',
  SWAP = 'SWAP',
  STAKE = 'STAKE',
  UNSTAKE = 'UNSTAKE',
}

/**
 * Represents the status of a cross-repo integration operation or transaction.
 */
export enum TrellisStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/**
 * Standardized error codes for cross-repo communication.
 */
export enum TrellisErrorCode {
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  UNAUTHORIZED = 'UNAUTHORIZED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  CONTRACT_REVERTED = 'CONTRACT_REVERTED',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Standardized error structure for Trellis cross-repo integrations.
 */
export interface TrellisError {
  code: TrellisErrorCode;
  message: string;
  details?: Record<string, any>;
}

/**
 * A standard request payload for a Trellis operation.
 */
export interface TrellisOperationRequest {
  operationType: TrellisOperationType;
  walletAddress: string;
  assetId: string;
  amount: string; // Using string to preserve precision for crypto amounts
  metadata?: Record<string, string>;
  signature?: string;
}

/**
 * A standard receipt for a completed Trellis operation.
 */
export interface TrellisReceipt {
  transactionId: string;
  operationType: TrellisOperationType;
  status: TrellisStatus;
  walletAddress: string;
  timestamp: string; // ISO 8601 string
  networkFee?: string;
  error?: TrellisError;
}

/**
 * Health check schema for validating API/Contract compatibility.
 */
export interface TrellisCompatibilityCheck {
  clientVersion: string;
  requiredApiVersion: string;
  requiredContractVersion: string;
  status: 'COMPATIBLE' | 'INCOMPATIBLE' | 'DEPRECATED';
}
