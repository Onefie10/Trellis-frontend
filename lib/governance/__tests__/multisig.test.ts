import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  aggregateSignatures,
  buildTreasurySpendEnvelope,
  exportPartialEnvelope,
  getSignatureProgress,
  importPartialEnvelope,
  signEnvelope,
  validateMultisigConfig,
} from '../multisig';

const NET = Networks.TESTNET;
const kps = [1, 2, 3, 4, 5].map(() => Keypair.random());
const signers = kps.map((k) => k.publicKey());

function buildTx(seq = '1'): string {
  const tx = new TransactionBuilder(new Account(signers[0], seq), {
    fee: '100',
    networkPassphrase: NET,
  })
    .addOperation(
      Operation.payment({ destination: signers[1], asset: Asset.native(), amount: '10' }),
    )
    .setTimeout(0)
    .build();
  return tx.toEnvelope().toXDR('base64');
}

describe('validateMultisigConfig', () => {
  it('accepts a valid 3-of-5 config', () => {
    expect(validateMultisigConfig({ signers, threshold: 3 })).toEqual([]);
  });
  it('rejects threshold above signer count', () => {
    expect(validateMultisigConfig({ signers, threshold: 6 })).toContain(
      'Threshold cannot exceed the number of signers.',
    );
  });
  it('rejects zero / non-integer thresholds', () => {
    expect(validateMultisigConfig({ signers, threshold: 0 }).length).toBeGreaterThan(0);
    expect(validateMultisigConfig({ signers, threshold: 1.5 }).length).toBeGreaterThan(0);
  });
  it('rejects duplicate and invalid signers', () => {
    expect(validateMultisigConfig({ signers: [signers[0], signers[0]], threshold: 1 })).toContain(
      'Signers must be unique.',
    );
    expect(
      validateMultisigConfig({ signers: ['nope'], threshold: 1 }).some((e) =>
        e.startsWith('Invalid signer'),
      ),
    ).toBe(true);
  });
});

describe('signature collection', () => {
  const config = { signers, threshold: 3 };

  it('tracks progress as signatures are added', () => {
    let env = buildTx();
    expect(getSignatureProgress(env, NET, config).collected).toBe(0);
    env = signEnvelope(env, NET, kps[0].secret());
    env = signEnvelope(env, NET, kps[1].secret());
    const p = getSignatureProgress(env, NET, config);
    expect(p.collected).toBe(2);
    expect(p.required).toBe(3);
    expect(p.isComplete).toBe(false);
    expect(p.pending).toHaveLength(3);
  });

  it('does not double count the same signer', () => {
    let env = signEnvelope(buildTx(), NET, kps[0].secret());
    env = signEnvelope(env, NET, kps[0].secret());
    expect(getSignatureProgress(env, NET, config).collected).toBe(1);
  });

  it('ignores signatures from unauthorised keys', () => {
    const env = signEnvelope(buildTx(), NET, Keypair.random().secret());
    const p = getSignatureProgress(env, NET, config);
    expect(p.collected).toBe(0);
    expect(p.invalidCount).toBe(1);
  });

  it('aggregates signatures from separate co-signers to reach threshold', () => {
    const base = buildTx();
    const a = signEnvelope(base, NET, kps[0].secret());
    const b = signEnvelope(base, NET, kps[2].secret());
    const c = signEnvelope(base, NET, kps[4].secret());
    const merged = aggregateSignatures([a, b, c, a], NET);
    const p = getSignatureProgress(merged, NET, config);
    expect(p.collected).toBe(3);
    expect(p.isComplete).toBe(true);
  });

  it('refuses to merge different transactions', () => {
    expect(() => aggregateSignatures([buildTx('1'), buildTx('2')], NET)).toThrow(/different/);
  });

  it('exports a shareable partial envelope and imports it back', () => {
    const env = signEnvelope(buildTx(), NET, kps[1].secret());
    const out = exportPartialEnvelope(env, NET, config);
    expect(out.collected).toBe(1);
    expect(out.threshold).toBe(3);
    expect(out.signedBy).toEqual([signers[1]]);
    expect(getSignatureProgress(out.xdr, NET, config).collected).toBe(1);

    // Import from JSON string
    const jsonStr = JSON.stringify(out);
    const importedXdr = importPartialEnvelope(jsonStr);
    expect(importedXdr).toBe(out.xdr);

    // Import from raw string
    expect(importPartialEnvelope(out.xdr)).toBe(out.xdr);

    // Invalid JSON throws
    expect(() => importPartialEnvelope('{invalid json')).toThrow(/Invalid JSON/);
  });

  it('builds a valid treasury spend envelope', () => {
    const xdr = buildTreasurySpendEnvelope({
      networkPassphrase: NET,
      treasuryAccount: signers[0],
      destination: signers[1],
      amount: '500.5',
      memo: 'Test Spend',
    });
    expect(typeof xdr).toBe('string');
    expect(xdr.length).toBeGreaterThan(0);
    const progress = getSignatureProgress(xdr, NET, config);
    expect(progress.collected).toBe(0);
    expect(progress.required).toBe(3);
  });
});
