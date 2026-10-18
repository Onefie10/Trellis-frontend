import {
  Account,
  Asset,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

export interface MultisigConfig {
  /** Public keys (G...) of authorised treasury signers. */
  signers: string[];
  /** Number of valid signatures required (M of N). */
  threshold: number;
}

export interface SignatureProgress {
  collected: number;
  required: number;
  total: number;
  /** Authorised signers whose signature on the envelope is valid. */
  signedBy: string[];
  /** Authorised signers who have not signed yet. */
  pending: string[];
  /** Signatures that match no authorised signer or fail verification. */
  invalidCount: number;
  isComplete: boolean;
}

/** Returns a list of problems with the config; empty means valid. */
export function validateMultisigConfig(config: MultisigConfig): string[] {
  const errors: string[] = [];
  const { signers, threshold } = config;
  if (!Number.isInteger(threshold) || threshold < 1) {
    errors.push('Threshold must be a positive integer.');
  }
  if (signers.length === 0) {
    errors.push('At least one signer is required.');
  }
  for (const s of signers) {
    if (!isValidPublicKey(s)) {
      errors.push(`Invalid signer public key: ${s}`);
    }
  }
  if (new Set(signers).size !== signers.length) {
    errors.push('Signers must be unique.');
  }
  if (Number.isInteger(threshold) && threshold > signers.length) {
    errors.push('Threshold cannot exceed the number of signers.');
  }
  return errors;
}

function isValidPublicKey(key: string): boolean {
  try {
    Keypair.fromPublicKey(key);
    return true;
  } catch {
    return false;
  }
}

export function parseEnvelope(envelopeXdr: string, networkPassphrase: string): Transaction {
  const tx = TransactionBuilder.fromXDR(envelopeXdr.trim(), networkPassphrase);
  if (!(tx instanceof Transaction)) {
    throw new Error('Fee-bump transactions are not supported for multisig collection.');
  }
  return tx;
}

/** Counts each authorised signer at most once, verifying against the tx hash. */
export function getSignatureProgress(
  envelopeXdr: string,
  networkPassphrase: string,
  config: MultisigConfig,
): SignatureProgress {
  const tx = parseEnvelope(envelopeXdr, networkPassphrase);
  const hash = tx.hash();
  const signedBy = new Set<string>();
  let invalidCount = 0;

  for (const sig of tx.signatures) {
    const match = config.signers.find((pub) => {
      try {
        return Keypair.fromPublicKey(pub).verify(hash, sig.signature());
      } catch {
        return false;
      }
    });
    if (match) signedBy.add(match);
    else invalidCount += 1;
  }

  const collected = signedBy.size;
  return {
    collected,
    required: config.threshold,
    total: config.signers.length,
    signedBy: [...signedBy],
    pending: config.signers.filter((s) => !signedBy.has(s)),
    invalidCount,
    isComplete: collected >= config.threshold,
  };
}

/** Signs the envelope with a secret key (never persisted) and returns the new XDR. */
export function signEnvelope(
  envelopeXdr: string,
  networkPassphrase: string,
  secret: string,
): string {
  const tx = parseEnvelope(envelopeXdr, networkPassphrase);
  const keypair = Keypair.fromSecret(secret);
  const hint = keypair.signatureHint();
  const hash = tx.hash();
  const already = tx.signatures.some(
    (s) => s.hint().equals(hint) && keypair.verify(hash, s.signature()),
  );
  if (!already) tx.sign(keypair);
  return tx.toEnvelope().toXDR('base64');
}

/**
 * Merges signatures from several copies of the same transaction (e.g. returned
 * by different co-signers). All copies must share the same transaction hash.
 */
export function aggregateSignatures(
  envelopeXdrs: string[],
  networkPassphrase: string,
): string {
  if (envelopeXdrs.length === 0) throw new Error('No envelopes to aggregate.');
  const base = parseEnvelope(envelopeXdrs[0], networkPassphrase);
  const baseHash = base.hash();
  const seen = new Set(base.signatures.map(sigKey));

  for (const other of envelopeXdrs.slice(1)) {
    const tx = parseEnvelope(other, networkPassphrase);
    if (!tx.hash().equals(baseHash)) {
      throw new Error('Envelopes describe different transactions and cannot be merged.');
    }
    for (const sig of tx.signatures) {
      const key = sigKey(sig);
      if (!seen.has(key)) {
        seen.add(key);
        base.addDecoratedSignature(sig);
      }
    }
  }
  return base.toEnvelope().toXDR('base64');
}

function sigKey(sig: xdr.DecoratedSignature): string {
  return `${sig.hint().toString('hex')}:${sig.signature().toString('hex')}`;
}

export interface PartialEnvelopePayload {
  xdr: string;
  networkPassphrase: string;
  threshold: number;
  signers: string[];
  collected: number;
  signedBy: string[];
}

/** Serialisable payload for sharing a partially signed envelope off-chain. */
export function exportPartialEnvelope(
  envelopeXdr: string,
  networkPassphrase: string,
  config: MultisigConfig,
): PartialEnvelopePayload {
  const progress = getSignatureProgress(envelopeXdr, networkPassphrase, config);
  return {
    xdr: parseEnvelope(envelopeXdr, networkPassphrase).toEnvelope().toXDR('base64'),
    networkPassphrase,
    threshold: config.threshold,
    signers: config.signers,
    collected: progress.collected,
    signedBy: progress.signedBy,
  };
}

/**
 * Extracts envelope XDR from either a raw base64 string or an exported JSON string.
 */
export function importPartialEnvelope(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Input is empty.');
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.xdr === 'string') {
        return parsed.xdr.trim();
      }
    } catch {
      throw new Error('Invalid JSON format for partial transaction envelope.');
    }
  }
  return trimmed;
}

export interface TreasurySpendEnvelopeParams {
  networkPassphrase: string;
  treasuryAccount: string;
  destination: string;
  amount: string;
  memo?: string;
  sequenceNumber?: string;
  baseFee?: string;
}

/**
 * Builds an unsigned (or initially single-source) treasury payment transaction envelope.
 */
export function buildTreasurySpendEnvelope(params: TreasurySpendEnvelopeParams): string {
  const account = new Account(params.treasuryAccount, params.sequenceNumber || '0');
  let builder = new TransactionBuilder(account, {
    fee: params.baseFee || '100',
    networkPassphrase: params.networkPassphrase,
  }).addOperation(
    Operation.payment({
      destination: params.destination,
      asset: Asset.native(),
      amount: params.amount,
    }),
  );

  if (params.memo) {
    builder = builder.addMemo(Memo.text(params.memo));
  }

  return builder.setTimeout(0).build().toEnvelope().toXDR('base64');
}

