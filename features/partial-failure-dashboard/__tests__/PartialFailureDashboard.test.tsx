/**
 * Tests for the Partial Failure Dashboard
 *
 * These tests verify:
 * - Dashboard renders correctly
 * - Filtering by status, severity, operation type, and age
 * - Sorting by various fields
 * - Inspecting failure details
 * - Retry functionality with safety checks
 * - Resolve and manual intervention actions
 * - User action required indicators
 * - Large dataset handling
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PartialFailureDashboard } from '../PartialFailureDashboard';
import { partialFailureTracker, type PartialFailure } from '@/lib/partial-failures';

describe('PartialFailureDashboard', () => {
  beforeEach(() => {
    partialFailureTracker.reset();
  });

  describe('rendering', () => {
    it('renders the dashboard with summary cards', () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');
      partialFailureTracker.recordFailure('webhook', 'webhook-1', { resourceId: 'res-2' }, 'Timeout', undefined, 'critical');

      render(<PartialFailureDashboard />);

      expect(screen.getByText('Partial Failure Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Total Failures')).toBeInTheDocument();
      expect(screen.getByText('Critical')).toBeInTheDocument();
    });

    it('shows empty state when no failures exist', () => {
      render(<PartialFailureDashboard />);

      expect(screen.getByText('No failures match the current filters.')).toBeInTheDocument();
    });

    it('displays failures in a table', () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      expect(screen.getByText('txn-1')).toBeInTheDocument();
      expect(screen.getByText('transaction')).toBeInTheDocument();
    });
  });

  describe('filtering', () => {
    it('filters by status', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Error 1');
      partialFailureTracker.recordFailure('webhook', 'webhook-1', { resourceId: 'res-2' }, 'Error 2');
      partialFailureTracker.markResolved('txn-1', 'Test resolution');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const statusFilter = screen.getByLabelText('Status');
        fireEvent.change(statusFilter, { target: { value: 'resolved' } });
      });

      await waitFor(() => {
        expect(screen.getByText('txn-1')).toBeInTheDocument();
        expect(screen.queryByText('webhook-1')).not.toBeInTheDocument();
      });
    });

    it('filters by severity', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Error 1', undefined, 'low');
      partialFailureTracker.recordFailure('webhook', 'webhook-1', { resourceId: 'res-2' }, 'Error 2', undefined, 'critical');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const severityFilter = screen.getByLabelText('Severity');
        fireEvent.change(severityFilter, { target: { value: 'critical' } });
      });

      await waitFor(() => {
        expect(screen.getByText('webhook-1')).toBeInTheDocument();
        expect(screen.queryByText('txn-1')).not.toBeInTheDocument();
      });
    });

    it('filters by operation type', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Error 1');
      partialFailureTracker.recordFailure('webhook', 'webhook-1', { resourceId: 'res-2' }, 'Error 2');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const typeFilter = screen.getByLabelText('Operation Type');
        fireEvent.change(typeFilter, { target: { value: 'transaction' } });
      });

      await waitFor(() => {
        expect(screen.getByText('txn-1')).toBeInTheDocument();
        expect(screen.queryByText('webhook-1')).not.toBeInTheDocument();
      });
    });

    it('filters by age', async () => {
      const oldFailure = partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Error 1');
      // Manually set createdAt to be old
      (oldFailure as any).createdAt = new Date(Date.now() - 86400000 * 10).toISOString(); // 10 days ago

      partialFailureTracker.recordFailure('webhook', 'webhook-1', { resourceId: 'res-2' }, 'Error 2');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const ageFilter = screen.getByLabelText('Age');
        fireEvent.change(ageFilter, { target: { value: '86400000' } }); // < 24 hours
      });

      await waitFor(() => {
        expect(screen.getByText('webhook-1')).toBeInTheDocument();
        expect(screen.queryByText('txn-1')).not.toBeInTheDocument();
      });
    });

    it('filters by search term', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-abc123', { resourceId: 'res-1' }, 'Network timeout');
      partialFailureTracker.recordFailure('webhook', 'webhook-xyz456', { resourceId: 'res-2' }, 'Database error');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const searchInput = screen.getByPlaceholderText('Search by ID, error, or resource...');
        fireEvent.change(searchInput, { target: { value: 'abc123' } });
      });

      await waitFor(() => {
        expect(screen.getByText('txn-abc123')).toBeInTheDocument();
        expect(screen.queryByText('webhook-xyz456')).not.toBeInTheDocument();
      });
    });

    it('combines multiple filters', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Error 1', undefined, 'critical');
      partialFailureTracker.recordFailure('webhook', 'webhook-1', { resourceId: 'res-2' }, 'Error 2', undefined, 'critical');
      partialFailureTracker.recordFailure('transaction', 'txn-2', { resourceId: 'res-3' }, 'Error 3', undefined, 'low');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const typeFilter = screen.getByLabelText('Operation Type');
        fireEvent.change(typeFilter, { target: { value: 'transaction' } });

        const severityFilter = screen.getByLabelText('Severity');
        fireEvent.change(severityFilter, { target: { value: 'critical' } });
      });

      await waitFor(() => {
        expect(screen.getByText('txn-1')).toBeInTheDocument();
        expect(screen.queryByText('webhook-1')).not.toBeInTheDocument();
        expect(screen.queryByText('txn-2')).not.toBeInTheDocument();
      });
    });
  });

  describe('sorting', () => {
    it('sorts by creation date', async () => {
      const failure1 = partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Error 1');
      (failure1 as any).createdAt = new Date(Date.now() - 10000).toISOString();

      const failure2 = partialFailureTracker.recordFailure('webhook', 'webhook-1', { resourceId: 'res-2' }, 'Error 2');
      (failure2 as any).createdAt = new Date(Date.now() - 5000).toISOString();

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const createdHeader = screen.getByText('Created');
        fireEvent.click(createdHeader);
      });

      await waitFor(() => {
        const rows = screen.getAllByText(/txn-|webhook-/);
        expect(rows[0]).toHaveTextContent('txn-1');
        expect(rows[1]).toHaveTextContent('webhook-1');
      });
    });

    it('sorts by severity', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Error 1', undefined, 'low');
      partialFailureTracker.recordFailure('webhook', 'webhook-1', { resourceId: 'res-2' }, 'Error 2', undefined, 'critical');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const severityHeader = screen.getByText('Severity');
        fireEvent.click(severityHeader);
      });

      await waitFor(() => {
        const rows = screen.getAllByText(/txn-|webhook-/);
        expect(rows[0]).toHaveTextContent('webhook-1'); // critical first
        expect(rows[1]).toHaveTextContent('txn-1'); // low second
      });
    });

    it('toggles sort order', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Error 1');
      partialFailureTracker.recordFailure('webhook', 'webhook-1', { resourceId: 'res-2' }, 'Error 2');

      render(<PartialFailureDashboard />);

      const createdHeader = screen.getByText('Created');

      // First click - descending
      await waitFor(() => fireEvent.click(createdHeader));
      await waitFor(() => {
        expect(screen.getByText('↓')).toBeInTheDocument();
      });

      // Second click - ascending
      await waitFor(() => fireEvent.click(createdHeader));
      await waitFor(() => {
        expect(screen.getByText('↑')).toBeInTheDocument();
      });
    });
  });

  describe('inspection', () => {
    it('expands failure details on inspect click', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const inspectButton = screen.getByText('Inspect');
        fireEvent.click(inspectButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Internal State')).toBeInTheDocument();
        expect(screen.getByText('Error Message')).toBeInTheDocument();
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('hides details on hide click', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const inspectButton = screen.getByText('Inspect');
        fireEvent.click(inspectButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Internal State')).toBeInTheDocument();
      });

      await waitFor(() => {
        const hideButton = screen.getByText('Hide');
        fireEvent.click(hideButton);
      });

      await waitFor(() => {
        expect(screen.queryByText('Internal State')).not.toBeInTheDocument();
      });
    });

    it('displays internal state JSON', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1', amount: 100 }, 'Network error');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const inspectButton = screen.getByText('Inspect');
        fireEvent.click(inspectButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/"resourceId":/)).toBeInTheDocument();
        expect(screen.getByText(/"amount":/)).toBeInTheDocument();
      });
    });
  });

  describe('retry functionality', () => {
    it('shows retry button for retryable failures', () => {
      const failure = partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('does not show retry button for non-retryable failures', () => {
      partialFailureTracker.recordFailure('import', 'import-1', { resourceId: 'res-1' }, 'Import error');

      render(<PartialFailureDashboard />);

      expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    });

    it('retries failure on button click', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const retryButton = screen.getByText('Retry');
        fireEvent.click(retryButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Failure queued for retry')).toBeInTheDocument();
      });

      const failure = partialFailureTracker.getFailure('txn-1');
      expect(failure?.retryCount).toBe(1);
      expect(failure?.status).toBe('retrying');
    });

    it('shows error message when retry fails', async () => {
      const failure = partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');
      // Exhaust retries
      for (let i = 0; i < 5; i++) {
        try {
          partialFailureTracker.retryFailure(failure.id);
        } catch {}
      }

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const retryButton = screen.getByText('Retry');
        fireEvent.click(retryButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Retry failed/)).toBeInTheDocument();
      });
    });

    it('hides retry button when max retries exceeded', () => {
      const failure = partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');
      // Exhaust retries
      for (let i = 0; i < 5; i++) {
        try {
          partialFailureTracker.retryFailure(failure.id);
        } catch {}
      }

      render(<PartialFailureDashboard />);

      expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    });
  });

  describe('resolve and manual intervention', () => {
    it('marks failure as resolved', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const inspectButton = screen.getByText('Inspect');
        fireEvent.click(inspectButton);
      });

      await waitFor(() => {
        const resolveButton = screen.getByText('Mark Resolved');
        fireEvent.click(resolveButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Failure marked as resolved')).toBeInTheDocument();
      });

      const failure = partialFailureTracker.getFailure('txn-1');
      expect(failure?.status).toBe('resolved');
    });

    it('marks failure for manual intervention', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const inspectButton = screen.getByText('Inspect');
        fireEvent.click(inspectButton);
      });

      await waitFor(() => {
        const manualButton = screen.getByText('Manual Intervention');
        fireEvent.click(manualButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Failure marked for manual intervention')).toBeInTheDocument();
      });

      const failure = partialFailureTracker.getFailure('txn-1');
      expect(failure?.status).toBe('manual_intervention');
    });

    it('ignores ignorable failures', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error', undefined, 'low');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const inspectButton = screen.getByText('Inspect');
        fireEvent.click(inspectButton);
      });

      await waitFor(() => {
        const ignoreButton = screen.getByText('Ignore');
        fireEvent.click(ignoreButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Failure ignored')).toBeInTheDocument();
      });

      const failure = partialFailureTracker.getFailure('txn-1');
      expect(failure?.status).toBe('resolved');
    });

    it('does not show ignore button for critical failures', () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Critical error', undefined, 'critical');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const inspectButton = screen.getByText('Inspect');
        fireEvent.click(inspectButton);
      });

      expect(screen.queryByText('Ignore')).not.toBeInTheDocument();
    });
  });

  describe('user action required indicators', () => {
    it('shows indicator for manual intervention failures', () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');
      partialFailureTracker.markManualIntervention('txn-1', 'Test');

      render(<PartialFailureDashboard />);

      expect(screen.getByText('Requires user action')).toBeInTheDocument();
    });

    it('shows indicator for critical failures', () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Critical error', undefined, 'critical');

      render(<PartialFailureDashboard />);

      expect(screen.getByText('Requires user action')).toBeInTheDocument();
    });

    it('shows indicator when max retries exceeded', () => {
      const failure = partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');
      // Exhaust retries
      for (let i = 0; i < 5; i++) {
        try {
          partialFailureTracker.retryFailure(failure.id);
        } catch {}
      }

      render(<PartialFailureDashboard />);

      expect(screen.getByText('Requires user action')).toBeInTheDocument();
    });

    it('does not show indicator for normal unresolved failures', () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error', undefined, 'medium');

      render(<PartialFailureDashboard />);

      expect(screen.queryByText('Requires user action')).not.toBeInTheDocument();
    });
  });

  describe('large dataset handling', () => {
    it('handles 100+ failures without performance issues', () => {
      for (let i = 0; i < 100; i++) {
        partialFailureTracker.recordFailure('transaction', `txn-${i}`, { resourceId: `res-${i}` }, `Error ${i}`);
      }

      const startTime = Date.now();
      render(<PartialFailureDashboard />);
      const renderTime = Date.now() - startTime;

      expect(renderTime).toBeLessThan(1000); // Should render in under 1 second
    });

    it('paginates or virtualizes large datasets (future enhancement)', () => {
      // This is a placeholder for future virtualization
      for (let i = 0; i < 1000; i++) {
        partialFailureTracker.recordFailure('transaction', `txn-${i}`, { resourceId: `res-${i}` }, `Error ${i}`);
      }

      render(<PartialFailureDashboard />);

      // For now, we expect it to render (may be slow without virtualization)
      expect(screen.getByText('Partial Failure Dashboard')).toBeInTheDocument();
    });
  });

  describe('message banners', () => {
    it('shows success message after successful operation', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const inspectButton = screen.getByText('Inspect');
        fireEvent.click(inspectButton);
      });

      await waitFor(() => {
        const resolveButton = screen.getByText('Mark Resolved');
        fireEvent.click(resolveButton);
      });

      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('Failure marked as resolved');
        expect(banner).toHaveClass('border-green-500/50');
      });
    });

    it('shows error message after failed operation', async () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');
      const failure = partialFailureTracker.getFailure('txn-1');
      // Exhaust retries
      for (let i = 0; i < 5; i++) {
        try {
          partialFailureTracker.retryFailure(failure!.id);
        } catch {}
      }

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const retryButton = screen.getByText('Retry');
        fireEvent.click(retryButton);
      });

      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent(/Retry failed/);
        expect(banner).toHaveClass('border-red-500/50');
      });
    });

    it('dismisses message after 5 seconds', async () => {
      jest.useFakeTimers();

      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      await waitFor(() => {
        const inspectButton = screen.getByText('Inspect');
        fireEvent.click(inspectButton);
      });

      await waitFor(() => {
        const resolveButton = screen.getByText('Mark Resolved');
        fireEvent.click(resolveButton);
      });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      jest.advanceTimersByTime(5000);

      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });

      jest.useRealTimers();
    });
  });

  describe('accessibility', () => {
    it('has proper ARIA labels', () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      expect(screen.getByLabelText('Status')).toBeInTheDocument();
      expect(screen.getByLabelText('Severity')).toBeInTheDocument();
      expect(screen.getByLabelText('Operation Type')).toBeInTheDocument();
      expect(screen.getByLabelText('Age')).toBeInTheDocument();
    });

    it('provides button labels for screen readers', () => {
      partialFailureTracker.recordFailure('transaction', 'txn-1', { resourceId: 'res-1' }, 'Network error');

      render(<PartialFailureDashboard />);

      const retryButton = screen.getByLabelText(/Retry txn-1/);
      expect(retryButton).toBeInTheDocument();
    });
  });
});
