import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { useReducedMotion, prefersReducedMotion } from '@/hooks/useReducedMotion';
import BugReportForm from '@/components/BugReportForm';
import SorobanFunctionForm from '@/components/soroban/SorobanFunctionForm';
import { MultisigTransactionBuilder } from '@/features/governance/components/MultisigTransactionBuilder';
import { ReferralTable } from '@/features/affiliate-dashboard/components/ReferralTable';
import { SubmissionTable } from '@/features/submissions-dashboard/components/SubmissionTable';
import MetricSeriesTable from '@/components/metrics/MetricSeriesTable';
import VirtualizedTradingTable from '@/components/trading/VirtualizedTradingTable';
import { PartialFailureDashboard } from '@/features/partial-failure-dashboard/PartialFailureDashboard';
import { partialFailureTracker } from '@/lib/partial-failures';
import RouteError from '@/app/error';
import GlobalError from '@/app/global-error';
import SessionRecovery from '@/features/wallet/components/SessionRecovery';
import { ConflictDialog } from '@/features/session-continuity/components/ConflictDialog';
import OfflineBanner from '@/components/OfflineBanner';

// Mock PWA and StellarWallet hooks for isolated error recovery tests
const mockRecoverSession = jest.fn();
jest.mock('@/components/context/StellarWalletProvider', () => ({
  useStellarWallet: () => ({
    recoverSession: mockRecoverSession,
  }),
}));

const mockUsePWA = jest.fn(() => ({ isOnline: false }));
jest.mock('@/hooks/usePWA', () => ({
  usePWA: () => mockUsePWA(),
}));

const mockFlushOfflineSubmissions = jest.fn().mockResolvedValue(undefined);
const mockGetPendingSubmissionCount = jest.fn().mockResolvedValue(2);
jest.mock('@/lib/pwa-utils', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      setupBackgroundSync: jest.fn(),
      getPendingSubmissionCount: mockGetPendingSubmissionCount,
      flushOfflineSubmissions: mockFlushOfflineSubmissions,
      submitData: jest.fn().mockResolvedValue({ success: true, queued: false }),
    }),
  },
}));

describe('Accessibility Regression Suite: Dense Forms, Tables, and Error Recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    partialFailureTracker.clearAll();
  });

  describe('1. Reduced Motion Support (useReducedMotion & motion-reduce styles)', () => {
    const originalMatchMedia = window.matchMedia;

    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('detects prefers-reduced-motion media query and reacts to dynamic changes', () => {
      let changeListener: ((event: MediaQueryListEvent) => void) | null = null;

      window.matchMedia = jest.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          changeListener = listener;
        },
        removeEventListener: jest.fn(),
      }));

      expect(prefersReducedMotion()).toBe(true);

      function MotionIndicator() {
        const reduced = useReducedMotion();
        return <div data-testid="motion-pref">{reduced ? 'reduced' : 'full'}</div>;
      }

      render(<MotionIndicator />);
      expect(screen.getByTestId('motion-pref')).toHaveTextContent('reduced');

      act(() => {
        changeListener?.({ matches: false } as MediaQueryListEvent);
      });
      expect(screen.getByTestId('motion-pref')).toHaveTextContent('full');
    });

    it('supports legacy MediaQueryList addListener/removeListener fallback', () => {
      let legacyListener: ((event: MediaQueryListEvent) => void) | null = null;
      const removeListener = jest.fn();

      window.matchMedia = jest.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addListener: (listener: (event: MediaQueryListEvent) => void) => {
          legacyListener = listener;
        },
        removeListener,
      }));

      function MotionIndicator() {
        const reduced = useReducedMotion();
        return <div data-testid="motion-pref">{reduced ? 'reduced' : 'full'}</div>;
      }

      const { unmount } = render(<MotionIndicator />);
      expect(screen.getByTestId('motion-pref')).toHaveTextContent('full');

      act(() => {
        legacyListener?.({ matches: true } as MediaQueryListEvent);
      });
      expect(screen.getByTestId('motion-pref')).toHaveTextContent('reduced');

      unmount();
      expect(removeListener).toHaveBeenCalled();
    });
  });

  describe('2. Dense Forms: Keyboard, Focus Recovery, and Error Announcements', () => {
    describe('BugReportForm', () => {
      it('exposes accessible form landmark, required attributes, and announces validation summary', () => {
        render(<BugReportForm onSubmit={jest.fn()} />);

        const form = screen.getByRole('form', { name: /bug report submission form/i });
        expect(form).toBeInTheDocument();

        const titleInput = screen.getByLabelText(/Bug Title/i);
        expect(titleInput).toHaveAttribute('aria-required', 'true');

        fireEvent.click(screen.getByRole('button', { name: /Submit Bug Report/i }));

        // Consolidated polite status summary is announced
        const summary = screen.getByTestId('bug-form-error-summary');
        expect(summary).toHaveAttribute('role', 'status');
        expect(summary).toHaveAttribute('aria-live', 'polite');
        expect(summary).toHaveTextContent(/Please resolve \d+ validation errors before submitting/i);

        // First invalid field (bug-title) receives focus and aria-invalid + aria-describedby
        expect(document.activeElement).toBe(titleInput);
        expect(titleInput).toHaveAttribute('aria-invalid', 'true');
        expect(titleInput).toHaveAttribute('aria-describedby', 'bug-title-error');
        expect(document.getElementById('bug-title-error')).toHaveAttribute('role', 'alert');
      });

      it('moves focus accurately to mapped DOM IDs (bug-steps, bug-expected, bug-actual, bug-email, agreeToTerms) on validation error', () => {
        render(<BugReportForm onSubmit={jest.fn()} />);

        // Fill title and description so stepsToReproduce is the first invalid field
        fireEvent.change(screen.getByLabelText(/Bug Title/i), {
          target: { value: 'Wallet connection timeout on testnet' },
        });
        fireEvent.change(screen.getByLabelText(/^Description/i), {
          target: { value: 'When connecting via Freighter on slow connections, the modal hangs.' },
        });

        fireEvent.click(screen.getByRole('button', { name: /Submit Bug Report/i }));

        const stepsInput = screen.getByLabelText(/Steps to Reproduce/i);
        expect(stepsInput).toHaveAttribute('id', 'bug-steps');
        expect(document.activeElement).toBe(stepsInput);

        // Fill steps so expectedBehavior becomes first invalid field
        fireEvent.change(stepsInput, {
          target: { value: '1. Open wallet settings\n2. Click connect' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Submit Bug Report/i }));

        const expectedInput = screen.getByLabelText(/Expected Behavior/i);
        expect(expectedInput).toHaveAttribute('id', 'bug-expected');
        expect(document.activeElement).toBe(expectedInput);

        // Fill expectedBehavior so actualBehavior becomes first invalid field
        fireEvent.change(expectedInput, {
          target: { value: 'Should show clear timeout recovery prompt' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Submit Bug Report/i }));

        const actualInput = screen.getByLabelText(/Actual Behavior/i);
        expect(actualInput).toHaveAttribute('id', 'bug-actual');
        expect(document.activeElement).toBe(actualInput);

        // Fill actualBehavior and invalid email so reporterEmail becomes first invalid field
        fireEvent.change(actualInput, {
          target: { value: 'Spinner continues indefinitely without recovery button' },
        });
        const emailInput = screen.getByLabelText(/Email \(optional/i);
        fireEvent.change(emailInput, { target: { value: 'not-an-email' } });
        fireEvent.click(screen.getByRole('button', { name: /Submit Bug Report/i }));

        expect(emailInput).toHaveAttribute('id', 'bug-email');
        expect(document.activeElement).toBe(emailInput);

        // Clear invalid email so agreeToTerms becomes first invalid field
        fireEvent.change(emailInput, { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: /Submit Bug Report/i }));

        const termsCheckbox = screen.getByRole('checkbox');
        expect(termsCheckbox).toHaveAttribute('id', 'agreeToTerms');
        expect(document.activeElement).toBe(termsCheckbox);
      });
    });

    describe('SorobanFunctionForm', () => {
      const functionSpec = {
        name: 'transfer',
        args: [
          { name: 'to', type: 'Address' as const },
          { name: 'amount', type: 'I128' as const },
        ],
        returns: 'Bool' as const,
      };

      it('associates argument labels, moves focus to first invalid input, and links error alerts via aria-describedby', () => {
        const onSubmit = jest.fn();
        render(<SorobanFunctionForm functionSpec={functionSpec as any} onSubmit={onSubmit} />);

        const toInput = screen.getByLabelText(/to/i);
        const amountInput = screen.getByLabelText(/amount/i);

        expect(toInput).toHaveAttribute('aria-required', 'true');
        expect(amountInput).toHaveAttribute('aria-required', 'true');

        fireEvent.click(screen.getByRole('button', { name: /Prepare transfer/i }));

        expect(onSubmit).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(toInput);
        expect(toInput).toHaveAttribute('aria-invalid', 'true');
        expect(toInput).toHaveAttribute('aria-describedby', 'soroban-transfer-to-error');
        expect(document.getElementById('soroban-transfer-to-error')).toHaveAttribute('role', 'alert');

        // Typing into the invalid field clears its error state
        fireEvent.change(toInput, {
          target: { value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
        });
        expect(toInput).toHaveAttribute('aria-invalid', 'false');
      });

      it('announces contract submission errors via an assertive alert region', async () => {
        const onSubmit = jest.fn().mockRejectedValue(new Error('Simulation failed: HostError(Value, InvalidInput)'));
        render(
          <SorobanFunctionForm
            functionSpec={{ name: 'ping', args: [], returns: 'Void' } as any}
            onSubmit={onSubmit}
          />
        );

        fireEvent.click(screen.getByRole('button', { name: /Prepare ping/i }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveAttribute('aria-live', 'assertive');
        expect(alert).toHaveTextContent('Simulation failed: HostError(Value, InvalidInput)');
      });
    });

    describe('MultisigTransactionBuilder', () => {
      it('associates labels with all generator and XDR inputs and announces invalid XDR errors assertively', () => {
        render(<MultisigTransactionBuilder />);

        expect(screen.getByLabelText(/Destination Public Key/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Amount \(XLM\)/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Memo \(Optional\)/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Transaction Envelope XDR/i)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/Transaction Envelope XDR/i), {
          target: { value: 'INVALID_XDR_STRING' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Load Envelope/i }));

        const alert = screen.getByRole('alert');
        expect(alert).toHaveAttribute('aria-live', 'assertive');
      });
    });
  });

  describe('3. Dense Tables: Headers, Sorting Semantics, Virtualization, and Expandable Rows', () => {
    describe('ReferralTable', () => {
      const sampleReferrals = [
        {
          id: 'ref-1',
          referralCode: 'TRELLIS1',
          referredUserName: 'Alice',
          referredUserAddress: 'GABC1234567890DEF',
          status: 'active' as const,
          commissionAmount: 120.5,
          createdAt: '2026-01-15T10:00:00Z',
        },
        {
          id: 'ref-2',
          referralCode: 'TRELLIS2',
          referredUserName: 'Bob',
          referredUserAddress: 'GXYZ9876543210CBA',
          status: 'converted' as const,
          commissionAmount: 45.0,
          createdAt: '2026-02-20T12:30:00Z',
        },
      ];

      it('exposes table aria-label, column header scopes, labelled filter/sort selects, and dynamic aria-sort attributes', () => {
        render(<ReferralTable referrals={sampleReferrals as any} isLoading={false} />);

        const table = screen.getByRole('table', { name: /Referrals/i });
        expect(table).toBeInTheDocument();

        const sortSelect = screen.getByLabelText(/Sort by:/i);
        const filterSelect = screen.getByLabelText(/Filter:/i);
        expect(sortSelect).toBeInTheDocument();
        expect(filterSelect).toBeInTheDocument();

        const dateHeader = screen.getByRole('columnheader', { name: /Date/i });
        const commissionHeader = screen.getByRole('columnheader', { name: /Commission/i });
        const statusHeader = screen.getByRole('columnheader', { name: /Status/i });

        // Default sort is Date descending
        expect(dateHeader).toHaveAttribute('aria-sort', 'descending');
        expect(commissionHeader).toHaveAttribute('aria-sort', 'none');
        expect(statusHeader).toHaveAttribute('aria-sort', 'none');

        // Changing Sort by select to status updates aria-sort on headers
        fireEvent.change(sortSelect, { target: { value: 'status' } });
        expect(statusHeader).toHaveAttribute('aria-sort', 'ascending');
        expect(dateHeader).toHaveAttribute('aria-sort', 'none');

        // Changing Sort by select to commission updates aria-sort on headers
        fireEvent.change(sortSelect, { target: { value: 'commission' } });
        expect(commissionHeader).toHaveAttribute('aria-sort', 'descending');
        expect(statusHeader).toHaveAttribute('aria-sort', 'none');
      });

      it('announces loading state with aria-busy and reduced-motion safe classes, and announces empty state politely', () => {
        const { rerender } = render(<ReferralTable referrals={[]} isLoading={true} />);

        const loadingStatus = screen.getByRole('status', { name: /Loading referrals/i });
        expect(loadingStatus).toHaveAttribute('aria-busy', 'true');
        expect(loadingStatus.querySelector('.motion-reduce\\:animate-none')).not.toBeNull();

        rerender(<ReferralTable referrals={[]} isLoading={false} />);
        const emptyStatus = screen.getByRole('status');
        expect(emptyStatus).toHaveAttribute('aria-live', 'polite');
        expect(emptyStatus).toHaveTextContent(/No referrals yet/i);
      });
    });

    describe('SubmissionTable & MetricSeriesTable', () => {
      it('renders SubmissionTable with accessible table name, column scopes, and polite empty state', () => {
        const { rerender } = render(<SubmissionTable submissions={[]} />);
        expect(screen.getByRole('status')).toHaveTextContent('No submissions available.');

        rerender(
          <SubmissionTable
            submissions={[
              {
                id: 'sub-101',
                txHash: '0xabc123',
                status: 'completed',
                timestamp: '2026-03-01T00:00:00Z',
              } as any,
            ]}
          />
        );

        const table = screen.getByRole('table', { name: /Submissions/i });
        expect(table).toBeInTheDocument();
        const headers = within(table).getAllByRole('columnheader');
        expect(headers).toHaveLength(6);
        headers.forEach((header) => expect(header).toHaveAttribute('scope', 'col'));
      });

      it('renders MetricSeriesTable with accessible table name and column scopes', () => {
        render(
          <MetricSeriesTable
            series={[
              {
                seriesName: 'rpc.latency.p95',
                points: [{ timestamp: 1700000000000, value: 142 }],
              } as any,
            ]}
          />
        );

        const table = screen.getByRole('table', { name: /Metric series/i });
        expect(table).toBeInTheDocument();
        const headers = within(table).getAllByRole('columnheader');
        expect(headers).toHaveLength(2);
        headers.forEach((header) => expect(header).toHaveAttribute('scope', 'col'));
      });
    });

    describe('VirtualizedTradingTable', () => {
      it('exposes ARIA table, row, columnheader, cell roles, and aria-rowcount for screen readers', () => {
        const { rerender } = render(<VirtualizedTradingTable data={[]} debounceMs={0} />);
        expect(screen.getByRole('status')).toHaveTextContent(/No trading data available/i);

        const rows = [
          {
            timestamp: 1700000000000,
            price: 0.125,
            volume: 25000,
            high: 0.13,
            low: 0.12,
            open: 0.121,
            close: 0.125,
          },
        ];

        rerender(<VirtualizedTradingTable data={rows} debounceMs={0} />);

        const table = screen.getByRole('table', { name: /Trading activity/i });
        expect(table).toHaveAttribute('aria-rowcount', '2');
        expect(within(table).getAllByRole('columnheader')).toHaveLength(8);
        expect(within(table).getAllByRole('cell')).toHaveLength(8);
      });
    });

    describe('PartialFailureDashboard', () => {
      it('provides aria-sort on sort buttons and aria-controls/region linkage on expandable failure rows', () => {
        const recorded = partialFailureTracker.recordFailure({
          operationType: 'transaction',
          operationId: 'tx-a11y-001',
          errorMessage: 'Horizon timeout waiting for ledger close',
          severity: 'critical',
          internalState: { resourceId: 'agent-77' },
          canRetry: true,
          maxRetries: 3,
        });

        render(<PartialFailureDashboard />);

        const createdSortBtn = screen.getByRole('button', { name: /Created/i });
        const severitySortBtn = screen.getByRole('button', { name: /Severity/i });

        expect(createdSortBtn).toHaveAttribute('aria-sort', 'descending');
        expect(severitySortBtn).toHaveAttribute('aria-sort', 'none');

        fireEvent.click(createdSortBtn);
        expect(createdSortBtn).toHaveAttribute('aria-sort', 'ascending');

        const inspectBtn = screen.getByRole('button', { name: 'Inspect' });
        expect(inspectBtn).toHaveAttribute('aria-expanded', 'false');
        expect(inspectBtn).toHaveAttribute('aria-controls', `failure-details-${recorded.id}`);

        fireEvent.click(inspectBtn);
        expect(inspectBtn).toHaveAttribute('aria-expanded', 'true');

        const detailsRegion = screen.getByRole('region', { name: `Details for ${recorded.operationId}` });
        expect(detailsRegion).toHaveAttribute('id', `failure-details-${recorded.id}`);
      });
    });
  });

  describe('4. Error Recovery Flows: Focus Management, Alert Dialogs, and Live Announcements', () => {
    it('RouteError focuses the "Try again" recovery button on mount and announces via assertive alert', () => {
      const reset = jest.fn();
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      render(<RouteError error={new Error('ChunkLoadError')} reset={reset} />);

      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('aria-live', 'assertive');
      expect(alert).toHaveAttribute('aria-atomic', 'true');

      const retryButton = screen.getByRole('button', { name: /Try again/i });
      expect(document.activeElement).toBe(retryButton);

      fireEvent.click(retryButton);
      expect(reset).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });

    it('GlobalError focuses the "Try again" recovery button on mount and announces via assertive alert', () => {
      const reset = jest.fn();
      render(<GlobalError error={new Error('RootLayoutError')} reset={reset} />);

      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('aria-live', 'assertive');

      const retryButton = screen.getByRole('button', { name: /Try again/i });
      expect(document.activeElement).toBe(retryButton);

      fireEvent.click(retryButton);
      expect(reset).toHaveBeenCalledTimes(1);
    });

    it('SessionRecovery sets aria-busy during recovery and announces success/error outcomes with appropriate live roles', async () => {
      mockRecoverSession.mockResolvedValueOnce(undefined);
      render(<SessionRecovery />);

      const button = screen.getByRole('button', { name: /Recover Previous Session/i });
      expect(button).toHaveAttribute('aria-busy', 'false');

      fireEvent.click(button);

      await waitFor(() => {
        const status = screen.getByRole('status');
        expect(status).toHaveAttribute('aria-live', 'polite');
        expect(status).toHaveTextContent('Session recovered successfully.');
      });

      // Simulate failed recovery
      mockRecoverSession.mockRejectedValueOnce(new Error('Encrypted key vault locked'));
      fireEvent.click(screen.getByRole('button', { name: /Recover Previous Session/i }));

      await waitFor(() => {
        const alert = screen.getByRole('alert');
        expect(alert).toHaveAttribute('aria-live', 'assertive');
        expect(alert).toHaveTextContent('Encrypted key vault locked');
      });
    });

    it('ConflictDialog renders as modal alertdialog, focuses first recovery action on open, and resolves on Escape key', () => {
      const onResolve = jest.fn();
      const conflict = {
        resourceId: 'draft-42',
        conflictType: 'concurrent_edit' as const,
        attemptedVersion: 2,
        currentVersion: 3,
        detectedAt: Date.now(),
      };

      render(<ConflictDialog conflict={conflict as any} onResolve={onResolve} isOpen={true} />);

      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'conflict-dialog-title');
      expect(dialog).toHaveAttribute('aria-describedby', 'conflict-dialog-description');

      const buttons = within(dialog).getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
      expect(document.activeElement).toBe(buttons[0]);

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onResolve).toHaveBeenCalledWith('discard');
    });

    it('OfflineBanner announces offline and queued changes politely and allows keyboard-accessible Sync now recovery', async () => {
      mockUsePWA.mockReturnValue({ isOnline: false });
      const { rerender } = render(<OfflineBanner />);

      await waitFor(() => {
        expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
      });

      const banner = screen.getByTestId('offline-banner');
      expect(banner).toHaveAttribute('role', 'status');
      expect(banner).toHaveAttribute('aria-live', 'polite');
      expect(banner).toHaveTextContent(/You're offline/i);

      // Reconnect with pending offline submissions
      mockUsePWA.mockReturnValue({ isOnline: true });
      rerender(<OfflineBanner />);

      const syncButton = await screen.findByRole('button', { name: /Sync now/i });
      fireEvent.click(syncButton);
      expect(mockFlushOfflineSubmissions).toHaveBeenCalledTimes(1);
    });
  });
});
