import * as StellarSdk from '@stellar/stellar-sdk';
import { getStellarServer, getNetworkPassphrase } from '../stellar';
import type { StellarNetwork } from '../types';
import {
  GovernanceConfig,
  Proposal,
  ProposalAction,
  VoteChoice,
  TreasuryBalance,
  TreasuryTransaction,
  Delegation,
} from './types';

const FEE = '1000';

export function buildMultisigGovernanceAccountTx(params: {
  network: StellarNetwork;
  sourceSecret: string;
  governanceAccountPublicKey: string;
  signerPublicKeys: string[];
  masterWeight: number;
  lowThreshold: number;
  medThreshold: number;
  highThreshold: number;
}): StellarSdk.Transaction {
  const {
    network,
    sourceSecret,
    governanceAccountPublicKey,
    signerPublicKeys,
    masterWeight,
    lowThreshold,
    medThreshold,
    highThreshold,
  } = params;

  const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecret);
  const server = getStellarServer(network);

  const account = new StellarSdk.Account(sourceKeypair.publicKey(), '0');
  const txBuilder = new StellarSdk.TransactionBuilder(account, {
    fee: FEE,
    networkPassphrase: getNetworkPassphrase(network),
  });

  txBuilder.addOperation(
    StellarSdk.Operation.createAccount({
      destination: governanceAccountPublicKey,
      startingBalance: '5',
    })
  );

  txBuilder.addOperation(
    StellarSdk.Operation.setOptions({
      source: governanceAccountPublicKey,
      masterWeight,
      lowThreshold,
      medThreshold,
      highThreshold,
    })
  );

  signerPublicKeys.forEach((signer) => {
    txBuilder.addOperation(
      StellarSdk.Operation.setOptions({
        source: governanceAccountPublicKey,
        signer: {
          ed25519PublicKey: signer,
          weight: 1,
        },
      })
    );
  });

  return txBuilder.setTimeout(0).build();
}

export async function getVotingPowerForAccount(
  accountId: string,
  config: GovernanceConfig
): Promise<number> {
  const server = getStellarServer(config.network);
  const account = await server.loadAccount(accountId);
  const balance = account.balances.find(
    (b: any) =>
      b.asset_code === config.governanceToken.code &&
      b.asset_issuer === config.governanceToken.issuer
  );
  if (!balance) return 0;
  return parseFloat(balance.balance);
}

export async function getVotingWeightForAccount(
  accountId: string,
  config: GovernanceConfig,
  options: { requireSybilVerification?: boolean } = {}
): Promise<{
  tokenBalance: number;
  linearVotingPower: number;
  quadraticVotingPower: number;
  isSybilVerified: boolean;
  sybilReasons: string[];
}> {
  const tokenBalance = await getVotingPowerForAccount(accountId, config);
  const { verifyStellarAccountSybilResistance } = await import('./sybil-resistance');
  const { calculateQuadraticVotingWeight } = await import('./quadratic-voting');

  const sybilCheck = await verifyStellarAccountSybilResistance(accountId, config.network, {
    minAccountAgeDays: config.minAccountAgeDays,
    minTransactionCount: config.minTransactionCount,
  });

  const isSybilVerified = sybilCheck.isVerified;
  const quadraticVotingPower =
    options.requireSybilVerification && !isSybilVerified
      ? 0
      : calculateQuadraticVotingWeight(tokenBalance);

  return {
    tokenBalance,
    linearVotingPower: tokenBalance,
    quadraticVotingPower,
    isSybilVerified,
    sybilReasons: sybilCheck.reasons,
  };
}

export async function getTotalVotingPower(
  votingAccounts: string[],
  config: GovernanceConfig
): Promise<number> {
  const powers = await Promise.all(
    votingAccounts.map((a) => getVotingPowerForAccount(a, config))
  );
  return powers.reduce((sum, p) => sum + p, 0);
}

export function buildSorobanProposalTx(params: {
  config: GovernanceConfig;
  creator: string;
  proposalId: string;
  title: string;
  description: string;
  action: ProposalAction;
}): StellarSdk.Transaction {
  const { config, creator, proposalId, title, description, action } = params;
  const contract = new (StellarSdk as any).Contract(config.sorobanContractId);

  const sourceAccount = new StellarSdk.Account(creator, '0');
  const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: FEE,
    networkPassphrase: getNetworkPassphrase(config.network),
  });

  const op = contract.call(
    'create_proposal',
    StellarSdk.nativeToScVal(proposalId, { type: 'string' }),
    StellarSdk.nativeToScVal(title, { type: 'string' }),
    StellarSdk.nativeToScVal(description, { type: 'string' }),
    StellarSdk.nativeToScVal(action.type, { type: 'string' })
  );

  builder.addOperation(op as any);

  return builder.setTimeout(0).build();
}

export function buildSorobanVoteTx(params: {
  config: GovernanceConfig;
  voter: string;
  proposalId: string;
  choice: VoteChoice;
}): StellarSdk.Transaction {
  const { config, voter, proposalId, choice } = params;
  const contract = new (StellarSdk as any).Contract(config.sorobanContractId);

  const sourceAccount = new StellarSdk.Account(voter, '0');
  const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: FEE,
    networkPassphrase: getNetworkPassphrase(config.network),
  });

  const op = contract.call(
    'vote',
    StellarSdk.nativeToScVal(proposalId, { type: 'string' }),
    StellarSdk.nativeToScVal(choice, { type: 'string' })
  );

  builder.addOperation(op as any);

  return builder.setTimeout(0).build();
}

export function buildExecuteProposalTx(params: {
  config: GovernanceConfig;
  executor: string;
  proposalId: string;
}): StellarSdk.Transaction {
  const { config, executor, proposalId } = params;
  const contract = new (StellarSdk as any).Contract(config.sorobanContractId);

  const sourceAccount = new StellarSdk.Account(executor, '0');
  const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: FEE,
    networkPassphrase: getNetworkPassphrase(config.network),
  });

  const op = contract.call(
    'execute_proposal',
    StellarSdk.nativeToScVal(proposalId, { type: 'string' })
  );

  builder.addOperation(op as any);

  return builder.setTimeout(config.timelockSeconds).build();
}

export async function getTreasuryBalance(
  config: GovernanceConfig
): Promise<TreasuryBalance> {
  const server = getStellarServer(config.network);
  const account = await server.loadAccount(config.treasuryAccount);
  const native = account.balances.find((b: any) => b.asset_type === 'native');
  return {
    account: config.treasuryAccount,
    balanceXlm: native ? native.balance : '0',
  };
}

export async function getTreasuryHistory(
  config: GovernanceConfig,
  limit = 20
): Promise<TreasuryTransaction[]> {
  const server = getStellarServer(config.network);
  const records = await server
    .payments()
    .forAccount(config.treasuryAccount)
    .limit(limit)
    .order('desc')
    .call();

  return records.records.map((r: any) => {
    const isIncoming = r.to === config.treasuryAccount;
    const type: TreasuryTransaction['type'] = isIncoming ? 'incoming' : 'outgoing';
    return {
      id: r.id,
      type,
      source: r.from,
      destination: r.to,
      amountXlm: r.amount,
      createdAt: r.created_at,
      hash: r.transaction_hash,
      memo: r.transaction?.memo ?? null,
    };
  });
}

export function buildDelegationTx(params: {
  network: StellarNetwork;
  governanceAccount: string;
  delegatorSecret: string;
  delegatePublicKey: string;
  weight: number;
}): StellarSdk.Transaction {
  const { network, governanceAccount, delegatorSecret, delegatePublicKey, weight } =
    params;
  const delegator = StellarSdk.Keypair.fromSecret(delegatorSecret);
  const account = new StellarSdk.Account(delegator.publicKey(), '0');

  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: FEE,
    networkPassphrase: getNetworkPassphrase(network),
  });

  builder.addOperation(
    StellarSdk.Operation.setOptions({
      source: governanceAccount,
      signer: {
        ed25519PublicKey: delegatePublicKey,
        weight,
      },
    })
  );

  return builder.setTimeout(0).build();
}

export function isProposalApproved(
  proposal: Proposal,
  totalVotingPower: number,
  config: GovernanceConfig
): boolean {
  if (config.useQuadraticVoting) {
    const quadApprovals =
      proposal.quadraticApprovals ??
      (proposal.approvals > 0 ? Math.sqrt(proposal.approvals) : 0);
    const quadRejections =
      proposal.quadraticRejections ??
      (proposal.rejections > 0 ? Math.sqrt(proposal.rejections) : 0);
    const quadAbstentions =
      proposal.quadraticAbstentions ??
      (proposal.abstentions > 0 ? Math.sqrt(proposal.abstentions) : 0);

    const participated = quadApprovals + quadRejections + quadAbstentions;
    const quadTotal =
      proposal.totalQuadraticVotingPowerAtCreation ??
      (totalVotingPower > 0 ? Math.sqrt(totalVotingPower) : 0);

    const quorumReached = participated >= quadTotal * config.minQuorumRatio;
    const approvalRatio = participated === 0 ? 0 : quadApprovals / participated;
    return quorumReached && approvalRatio >= config.requiredApprovalRatio;
  }

  const participated = proposal.approvals + proposal.rejections + proposal.abstentions;
  const quorumReached = participated >= totalVotingPower * config.minQuorumRatio;
  const approvalRatio =
    participated === 0 ? 0 : proposal.approvals / participated;
  return quorumReached && approvalRatio >= config.requiredApprovalRatio;
}

export function getDelegationFromSigner(
  signer: StellarSdk.xdr.Signer
): Delegation | null {
  if (!signer.key()?.switch()?.name || !signer.weight()) return null;
  return null; // Mock implementation
}

export function isTimelockExpired(proposal: Proposal): boolean {
  if (!proposal.executionEta) return false;
  return Date.now() >= new Date(proposal.executionEta).getTime();
}

export function calculateDelegatedVotingPower(
  accountId: string,
  delegations: Delegation[],
  accountBalances: Record<string, number>
): number {
  let power = accountBalances[accountId] || 0;
  
  // Add power from accounts that delegated to this account
  for (const del of delegations) {
    if (del.delegate === accountId) {
      power += accountBalances[del.delegator] || 0;
    }
  }
  return power;
}

export * from './multisig';
