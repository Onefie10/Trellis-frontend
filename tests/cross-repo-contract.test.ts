import {
  TrellisOperationType,
  TrellisStatus,
  TrellisErrorCode,
  TrellisOperationRequest,
  TrellisReceipt,
  TrellisError
} from '../types/cross-repo-contract';

describe('Cross-Repo Integration Contract', () => {
  it('should have the expected TrellisOperationType values', () => {
    // This test ensures we don't accidentally remove or rename core operation types
    // without intentionally updating this test (acting as a drift detector).
    expect(TrellisOperationType.DEPOSIT).toBe('DEPOSIT');
    expect(TrellisOperationType.WITHDRAW).toBe('WITHDRAW');
    expect(TrellisOperationType.SWAP).toBe('SWAP');
    expect(TrellisOperationType.STAKE).toBe('STAKE');
    expect(TrellisOperationType.UNSTAKE).toBe('UNSTAKE');
  });

  it('should have the expected TrellisStatus values', () => {
    expect(TrellisStatus.PENDING).toBe('PENDING');
    expect(TrellisStatus.PROCESSING).toBe('PROCESSING');
    expect(TrellisStatus.SUCCESS).toBe('SUCCESS');
    expect(TrellisStatus.FAILED).toBe('FAILED');
    expect(TrellisStatus.CANCELLED).toBe('CANCELLED');
  });

  it('should have the expected TrellisErrorCode values', () => {
    expect(TrellisErrorCode.INSUFFICIENT_FUNDS).toBe('INSUFFICIENT_FUNDS');
    expect(TrellisErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(TrellisErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
    expect(TrellisErrorCode.CONTRACT_REVERTED).toBe('CONTRACT_REVERTED');
    expect(TrellisErrorCode.VALIDATION_FAILED).toBe('VALIDATION_FAILED');
    expect(TrellisErrorCode.UNKNOWN_ERROR).toBe('UNKNOWN_ERROR');
  });

  it('should allow constructing a valid TrellisOperationRequest', () => {
    const req: TrellisOperationRequest = {
      operationType: TrellisOperationType.DEPOSIT,
      walletAddress: 'GDXJ...',
      assetId: 'USDC',
      amount: '100.50',
    };
    
    expect(req.operationType).toBe(TrellisOperationType.DEPOSIT);
    expect(req.amount).toBe('100.50');
  });

  it('should allow constructing a valid TrellisReceipt with an error', () => {
    const error: TrellisError = {
      code: TrellisErrorCode.INSUFFICIENT_FUNDS,
      message: 'Not enough XLM for fee',
    };

    const receipt: TrellisReceipt = {
      transactionId: 'tx-12345',
      operationType: TrellisOperationType.WITHDRAW,
      status: TrellisStatus.FAILED,
      walletAddress: 'GDXJ...',
      timestamp: new Date().toISOString(),
      error,
    };

    expect(receipt.status).toBe(TrellisStatus.FAILED);
    expect(receipt.error?.code).toBe(TrellisErrorCode.INSUFFICIENT_FUNDS);
  });
});
