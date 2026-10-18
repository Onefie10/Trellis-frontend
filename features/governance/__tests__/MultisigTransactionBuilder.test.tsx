import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { MultisigTransactionBuilder } from '../components/MultisigTransactionBuilder';
import { buildTreasurySpendEnvelope, signEnvelope } from '@/lib/governance/multisig';

const NET = Networks.TESTNET;

describe('MultisigTransactionBuilder UI', () => {
  const kps = [Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random()];
  const signers = kps.map((k) => k.publicKey());
  const threshold = 3;

  function createTestEnvelope(): string {
    return buildTreasurySpendEnvelope({
      networkPassphrase: NET,
      treasuryAccount: signers[0],
      destination: signers[1],
      amount: '100',
      memo: 'Test Spend',
    });
  }

  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    });
    window.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
    window.URL.revokeObjectURL = jest.fn();
  });

  it('displays configuration validation errors when invalid', () => {
    render(
      <MultisigTransactionBuilder
        networkPassphrase={NET}
        signers={[]}
        threshold={0}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Threshold must be a positive integer/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/At least one signer is required/i);
  });

  it('renders initial empty envelope with generator form and builds base transaction', () => {
    render(
      <MultisigTransactionBuilder
        networkPassphrase={NET}
        signers={signers}
        threshold={threshold}
        treasuryAccount={signers[0]}
        proposalId="TIP-043"
        proposalTitle="Test Treasury Spend"
      />
    );

    expect(screen.getByText(/3-of-5 Signers/i)).toBeInTheDocument();
    expect(screen.getByText(/Initialize Treasury Transfer Envelope/i)).toBeInTheDocument();

    // Fill generator
    fireEvent.change(screen.getByPlaceholderText('G...'), { target: { value: signers[1] } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 5000'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Base Treasury Envelope/i }));

    // Now progress is shown
    expect(screen.getByTestId('signature-progress')).toHaveTextContent('0/3 required signatures gathered');
  });

  it('tracks progress and updates as signatures are added with secret key', async () => {
    const initialXdr = createTestEnvelope();
    const onComplete = jest.fn();

    render(
      <MultisigTransactionBuilder
        initialXdr={initialXdr}
        networkPassphrase={NET}
        signers={signers}
        threshold={threshold}
        onComplete={onComplete}
      />
    );

    // Initial state: 0/3 signatures
    expect(screen.getByTestId('signature-progress')).toHaveTextContent('0/3 required signatures gathered');

    // Sign with Signer 0
    const secretInput = screen.getByLabelText('Signer secret key');
    const signButton = screen.getByRole('button', { name: /Sign Envelope/i });

    fireEvent.change(secretInput, { target: { value: kps[0].secret() } });
    fireEvent.click(signButton);

    expect(screen.getByTestId('signature-progress')).toHaveTextContent('1/3 required signatures gathered');
    expect(onComplete).not.toHaveBeenCalled();

    // Sign with Signer 1
    fireEvent.change(secretInput, { target: { value: kps[1].secret() } });
    fireEvent.click(signButton);

    expect(screen.getByTestId('signature-progress')).toHaveTextContent('2/3 required signatures gathered');
    expect(onComplete).not.toHaveBeenCalled();

    // Sign with Signer 2 - reaching 3/3 threshold
    fireEvent.change(secretInput, { target: { value: kps[2].secret() } });
    fireEvent.click(signButton);

    expect(screen.getByTestId('signature-progress')).toHaveTextContent('3/3 required signatures gathered');
    expect(screen.getByText(/Threshold Reached/i)).toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('merges co-signer signatures from raw XDR or exported JSON payload', () => {
    const base = createTestEnvelope();
    const signer0Tx = signEnvelope(base, NET, kps[0].secret());
    const signer1Tx = signEnvelope(base, NET, kps[1].secret());
    const signer2Tx = signEnvelope(base, NET, kps[2].secret());

    const { rerender } = render(
      <MultisigTransactionBuilder
        initialXdr={signer0Tx}
        networkPassphrase={NET}
        signers={signers}
        threshold={threshold}
      />
    );

    expect(screen.getByTestId('signature-progress')).toHaveTextContent('1/3 required signatures gathered');

    // Merge signer 1 raw XDR
    const mergeInput = screen.getByLabelText('Co-signer envelope XDR');
    const mergeButton = screen.getByRole('button', { name: /Merge Signatures/i });

    fireEvent.change(mergeInput, { target: { value: signer1Tx } });
    fireEvent.click(mergeButton);

    expect(screen.getByTestId('signature-progress')).toHaveTextContent('2/3 required signatures gathered');

    // Merge signer 2 JSON payload
    const jsonPayload = JSON.stringify({
      xdr: signer2Tx,
      networkPassphrase: NET,
      threshold: 3,
      signers,
      collected: 1,
      signedBy: [signers[2]],
    });

    fireEvent.change(mergeInput, { target: { value: jsonPayload } });
    fireEvent.click(mergeButton);

    expect(screen.getByTestId('signature-progress')).toHaveTextContent('3/3 required signatures gathered');
    expect(screen.getByText(/Ready to execute/i)).toBeInTheDocument();
  });

  it('supports copying XDR, exporting JSON, and submitting when complete', async () => {
    let env = createTestEnvelope();
    env = signEnvelope(env, NET, kps[0].secret());
    env = signEnvelope(env, NET, kps[1].secret());
    env = signEnvelope(env, NET, kps[2].secret());

    const onSubmit = jest.fn().mockResolvedValue(undefined);

    render(
      <MultisigTransactionBuilder
        initialXdr={env}
        networkPassphrase={NET}
        signers={signers}
        threshold={threshold}
        onSubmit={onSubmit}
      />
    );

    // Copy XDR
    const copyXdrBtn = screen.getByRole('button', { name: /Copy XDR/i });
    fireEvent.click(copyXdrBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(env);

    // Copy JSON
    const copyJsonBtn = screen.getByRole('button', { name: /Copy JSON/i });
    fireEvent.click(copyJsonBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalled();

    // Export Partial JSON download
    const exportBtn = screen.getByRole('button', { name: /Export Partial JSON/i });
    fireEvent.click(exportBtn);
    expect(window.URL.createObjectURL).toHaveBeenCalled();

    // Submit button is active
    const submitBtn = screen.getByRole('button', { name: /Submit Transaction On-Chain/i });
    expect(submitBtn).not.toBeDisabled();
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(env);
    });
  });

  it('shows error if invalid secret key or invalid merge XDR is provided', () => {
    const base = createTestEnvelope();

    render(
      <MultisigTransactionBuilder
        initialXdr={base}
        networkPassphrase={NET}
        signers={signers}
        threshold={threshold}
      />
    );

    // Try signing with invalid secret
    fireEvent.change(screen.getByLabelText('Signer secret key'), { target: { value: 'invalid-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign Envelope/i }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Try merging completely incompatible XDR
    const otherTx = buildTreasurySpendEnvelope({
      networkPassphrase: NET,
      treasuryAccount: signers[1],
      destination: signers[0],
      amount: '999',
    });
    fireEvent.change(screen.getByLabelText('Co-signer envelope XDR'), { target: { value: otherTx } });
    fireEvent.click(screen.getByRole('button', { name: /Merge Signatures/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/different transactions/i);
  });
});
