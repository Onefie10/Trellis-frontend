import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { nativeToScVal } from '@stellar/stellar-sdk';
import type { Proposal } from '@/lib/governance/types';
import {
  getExplorerContractUrl,
  getExplorerLedgerUrl,
  getExplorerTransactionUrl,
  getTransactionExplorerLinks,
  isValidTransactionHash,
} from '@/lib/stellar-constants';
import {
  buildProposalExecutionTimeline,
  fetchTransactionRecord,
  formatStroopsAsXlm,
  parseContractEvents,
  parseHorizonTransaction,
  parseTransactionStatus,
  totalFeesStroops,
} from '../utils/executionTimeline';
import { ProposalExecutionTimeline } from '../components/ProposalExecutionTimeline';

const HASH = 'a'.repeat(32) + 'B'.repeat(32);
const LOWER_HASH = HASH.toLowerCase();
const jsonResponse = (body: unknown, status = 200) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'TIP-1',
    title: 'Test',
    description: 'desc',
    type: 'update_params',
    creator: 'GCREATOR',
    createdAt: '2026-01-01T00:00:00.000Z',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-05T00:00:00.000Z',
    status: 'active',
    action: { type: 'update_params', params: {} },
    approvals: 0,
    rejections: 0,
    abstentions: 0,
    totalVotingPowerAtCreation: 0,
    ...overrides,
  };
}

describe('block explorer URL formatting', () => {
  it('builds StellarExpert transaction URLs per network', () => {
    expect(getExplorerTransactionUrl('mainnet', HASH)).toBe(
      `https://stellar.expert/explorer/public/tx/${LOWER_HASH}`,
    );
    expect(getExplorerTransactionUrl('testnet', HASH)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${LOWER_HASH}`,
    );
  });

  it('builds Stellar.org Horizon transaction URLs', () => {
    expect(getExplorerTransactionUrl('testnet', HASH, 'stellarOrg')).toBe(
      `https://horizon-testnet.stellar.org/transactions/${LOWER_HASH}`,
    );
    expect(getExplorerTransactionUrl('mainnet', HASH, 'stellarOrg')).toBe(
      `https://horizon.stellar.org/transactions/${LOWER_HASH}`,
    );
  });

  it('accepts "public"/"pubnet" aliases and trims whitespace in hashes', () => {
    expect(getExplorerTransactionUrl('PUBLIC', ` ${HASH} `)).toBe(
      `https://stellar.expert/explorer/public/tx/${LOWER_HASH}`,
    );
    expect(getExplorerTransactionUrl('pubnet', HASH)).toContain('/explorer/public/');
  });

  it('returns null for malformed hashes and throws for unknown networks', () => {
    expect(getExplorerTransactionUrl('testnet', 'abc')).toBeNull();
    expect(getExplorerTransactionUrl('testnet', 'z'.repeat(64))).toBeNull();
    expect(() => getExplorerTransactionUrl('devnet', HASH)).toThrow(/Unsupported/);
  });

  it('falls back to Horizon only on futurenet, which StellarExpert does not index', () => {
    expect(getExplorerTransactionUrl('futurenet', HASH)).toBeNull();
    const links = getTransactionExplorerLinks('futurenet', HASH);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ explorer: 'stellarOrg', label: 'Stellar.org Horizon' });
    expect(getTransactionExplorerLinks('testnet', HASH).map((l) => l.explorer)).toEqual([
      'stellarExpert',
      'stellarOrg',
    ]);
  });

  it('builds ledger and contract URLs and validates their inputs', () => {
    expect(getExplorerLedgerUrl('testnet', 1234)).toBe('https://stellar.expert/explorer/testnet/ledger/1234');
    expect(getExplorerLedgerUrl('mainnet', 1234, 'stellarOrg')).toBe('https://horizon.stellar.org/ledgers/1234');
    expect(getExplorerLedgerUrl('testnet', 0)).toBeNull();
    expect(getExplorerLedgerUrl('testnet', 1.5)).toBeNull();
    expect(getExplorerContractUrl('testnet', CONTRACT_ID)).toBe(
      `https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`,
    );
    expect(getExplorerContractUrl('testnet', 'GABC')).toBeNull();
  });

  it('validates transaction hashes', () => {
    expect(isValidTransactionHash(HASH)).toBe(true);
    expect(isValidTransactionHash(undefined)).toBe(false);
    expect(isValidTransactionHash('f'.repeat(63))).toBe(false);
  });
});

describe('transaction status parsing', () => {
  it.each([
    ['SUCCESS', 'success'],
    ['success', 'success'],
    ['FAILED', 'failed'],
    ['ERROR', 'failed'],
    ['NOT_FOUND', 'not_found'],
    ['PENDING', 'pending'],
    ['DUPLICATE', 'pending'],
    ['TRY_AGAIN_LATER', 'pending'],
    ['weird', 'unknown'],
  ])('maps %s to %s', (raw, expected) => {
    expect(parseTransactionStatus(raw)).toBe(expected);
  });

  it('reads Horizon `successful` flags and nested `status` fields', () => {
    expect(parseTransactionStatus({ successful: true })).toBe('success');
    expect(parseTransactionStatus({ successful: false })).toBe('failed');
    expect(parseTransactionStatus({ status: 'NOT_FOUND' })).toBe('not_found');
    expect(parseTransactionStatus(null)).toBe('unknown');
    expect(parseTransactionStatus(42)).toBe('unknown');
  });

  it('parses a Horizon transaction record into audit fields', () => {
    const parsed = parseHorizonTransaction({
      hash: HASH,
      ledger: 51234,
      fee_charged: '100',
      created_at: '2026-01-02T00:00:00Z',
      successful: true,
      source_account: 'GSOURCE',
    });
    expect(parsed).toEqual({
      txHash: LOWER_HASH,
      ledger: 51234,
      feeChargedStroops: '100',
      timestamp: '2026-01-02T00:00:00Z',
      actor: 'GSOURCE',
      status: 'SUCCESS',
      txStatus: 'success',
    });
    expect(parseHorizonTransaction(undefined)).toEqual({ txStatus: 'unknown' });
    expect(parseHorizonTransaction({ ledger: -1 }).ledger).toBeUndefined();
  });

  it('formats stroops as XLM with 7 decimals', () => {
    expect(formatStroopsAsXlm('100')).toBe('0.0000100 XLM');
    expect(formatStroopsAsXlm(12_345_678)).toBe('1.2345678 XLM');
    expect(formatStroopsAsXlm('-5')).toBe('-0.0000005 XLM');
    expect(formatStroopsAsXlm(undefined)).toBeNull();
    expect(formatStroopsAsXlm('not-a-number')).toBeNull();
  });

  it('decodes XDR contract event topics and values', () => {
    const events = parseContractEvents([
      {
        type: 'contract',
        contractId: CONTRACT_ID,
        topic: [
          nativeToScVal('proposal', { type: 'symbol' }).toXDR('base64'),
          nativeToScVal('queued', { type: 'symbol' }).toXDR('base64'),
        ],
        value: nativeToScVal(7, { type: 'u32' }).toXDR('base64'),
      },
      { type: 'diagnostic', topics: ['plain'], value: 'text' },
      null,
    ]);
    expect(events).toEqual([
      { type: 'contract', contractId: CONTRACT_ID, topics: ['proposal', 'queued'], value: '7' },
      { type: 'diagnostic', contractId: undefined, topics: ['plain'], value: 'text' },
    ]);
    expect(parseContractEvents('nope')).toEqual([]);
  });
});

describe('fetchTransactionRecord', () => {
  it('queries the network Horizon and parses the record', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ hash: HASH, ledger: 9, fee_charged: '200', successful: true }),
    ) as unknown as typeof fetch;
    const record = await fetchTransactionRecord('testnet', HASH, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(`https://horizon-testnet.stellar.org/transactions/${LOWER_HASH}`);
    expect(record).toMatchObject({ ledger: 9, feeChargedStroops: '200', txStatus: 'success' });
  });

  it('reports not_found on 404 and throws on other errors', async () => {
    const notFound = jest.fn(async () => jsonResponse(null, 404)) as unknown as typeof fetch;
    await expect(fetchTransactionRecord('testnet', HASH, notFound)).resolves.toMatchObject({ txStatus: 'not_found' });
    const broken = jest.fn(async () => jsonResponse(null, 503)) as unknown as typeof fetch;
    await expect(fetchTransactionRecord('testnet', HASH, broken)).rejects.toThrow(/503/);
  });
});

describe('buildProposalExecutionTimeline', () => {
  it('synthesises the creation step and projects upcoming steps for an active proposal', () => {
    const steps = buildProposalExecutionTimeline(makeProposal());
    expect(steps.map((s) => [s.step, s.state])).toEqual([
      ['created', 'confirmed'],
      ['voting_closed', 'upcoming'],
      ['queued', 'upcoming'],
      ['executed', 'upcoming'],
    ]);
    expect(steps[1].timestamp).toBe('2026-01-05T00:00:00.000Z');
  });

  it('orders recorded steps chronologically and maps transaction status to state', () => {
    const steps = buildProposalExecutionTimeline(
      makeProposal({
        status: 'queued',
        executionHistory: [
          { step: 'queued', txHash: HASH, status: 'PENDING', timestamp: '2026-01-06T00:00:00Z' },
          { step: 'created', txHash: 'c'.repeat(64), ledger: 10, feeChargedStroops: '150', status: 'SUCCESS', timestamp: '2026-01-01T00:00:00Z' },
          { step: 'vote_cast', txHash: 'd'.repeat(64), status: 'FAILED', timestamp: '2026-01-02T00:00:00Z' },
        ],
      }),
    );
    expect(steps.map((s) => [s.step, s.state])).toEqual([
      ['created', 'confirmed'],
      ['vote_cast', 'failed'],
      ['queued', 'pending'],
      ['executed', 'upcoming'],
    ]);
    expect(steps[2].txHash).toBe(LOWER_HASH);
    expect(totalFeesStroops(steps)).toBe('150');
  });

  it('drops invalid hashes and ledgers rather than linking to them', () => {
    const [step] = buildProposalExecutionTimeline(
      makeProposal({
        status: 'executed',
        executionHistory: [{ step: 'created', txHash: 'bad', ledger: -3, timestamp: '2026-01-01T00:00:00Z' }],
      }),
    );
    expect(step.txHash).toBeUndefined();
    expect(step.ledger).toBeUndefined();
  });
});

describe('<ProposalExecutionTimeline />', () => {
  const executed = makeProposal({
    status: 'executed',
    executionHistory: [
      {
        step: 'created',
        txHash: HASH,
        ledger: 77,
        feeChargedStroops: '12345',
        status: 'SUCCESS',
        timestamp: '2026-01-01T00:00:00Z',
        events: [{ type: 'contract', topics: ['proposal', 'created'], value: 'TIP-1' }],
      },
      { step: 'executed', txHash: 'e'.repeat(64), status: 'SUCCESS', timestamp: '2026-01-06T00:00:00Z' },
    ],
  });

  it('renders every step with explorer links, ledger, and fee', () => {
    render(<ProposalExecutionTimeline proposal={executed} network="testnet" />);
    expect(screen.getByTestId('timeline-step-created')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-step-executed')).toBeInTheDocument();

    const expertLinks = screen.getAllByRole('link', { name: /StellarExpert/ });
    expect(expertLinks).toHaveLength(2);
    expect(expertLinks[0]).toHaveAttribute('href', `https://stellar.expert/explorer/testnet/tx/${LOWER_HASH}`);
    expect(screen.getByRole('link', { name: '#77' })).toHaveAttribute(
      'href',
      'https://stellar.expert/explorer/testnet/ledger/77',
    );
    expect(screen.getAllByText('0.0012345 XLM').length).toBeGreaterThan(0);
  });

  it('toggles contract event logs', () => {
    render(<ProposalExecutionTimeline proposal={executed} network="testnet" />);
    const toggle = screen.getByRole('button', { name: /show contract events \(1\)/i });
    fireEvent.click(toggle);
    expect(screen.getByText('proposal · created')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('verifies a step against Horizon', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ hash: HASH, ledger: 77, fee_charged: '12345', successful: true }),
    ) as unknown as typeof fetch;
    render(<ProposalExecutionTimeline proposal={executed} network="testnet" fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getAllByRole('button', { name: /verify on ledger/i })[0]);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Ledger reports success in ledger #77'));
  });
});
