'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  partialFailureTracker,
  type PartialFailure,
  type FailureStatus,
  type FailureSeverity,
  type OperationType,
  type FailureReport,
} from '@/lib/partial-failures';

/**
 * Partial Failure Dashboard
 *
 * Displays unresolved partial failures from async jobs, integrations, and user-visible operations.
 * Operators can filter failures, inspect causes, retry safely, and see when user action is required.
 *
 * Features:
 * - Filter by status, severity, operation type, and age
 * - Inspect detailed failure information
 * - Retry failures with safety checks
 * - Mark failures as resolved or for manual intervention
 * - View critical and stale failures prominently
 * - Track retry attempts and next retry time
 */

const STATUS_OPTIONS: { value: FailureStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'unresolved', label: 'Unresolved' },
  { value: 'retrying', label: 'Retrying' },
  { value: 'manual_intervention', label: 'Manual Intervention' },
  { value: 'resolved', label: 'Resolved' },
];

const SEVERITY_OPTIONS: { value: FailureSeverity | 'all'; label: string }[] = [
  { value: 'all', label: 'All Severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const OPERATION_TYPE_OPTIONS: { value: OperationType | 'all'; label: string }[] = [
  { value: 'all', label: 'All Types' },
  { value: 'transaction', label: 'Transaction' },
  { value: 'sync', label: 'Sync' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'import', label: 'Import' },
  { value: 'export', label: 'Export' },
  { value: 'background_job', label: 'Background Job' },
];

const AGE_OPTIONS: { value: number | 'all'; label: string }[] = [
  { value: 'all', label: 'All Ages' },
  { value: 3600000, label: '< 1 hour' },
  { value: 86400000, label: '< 24 hours' },
  { value: 604800000, label: '< 7 days' },
  { value: 2592000000, label: '< 30 days' },
];

type FilterState = {
  status: FailureStatus | 'all';
  severity: FailureSeverity | 'all';
  operationType: OperationType | 'all';
  maxAge: number | 'all';
  searchTerm: string;
};

type SortField = 'createdAt' | 'updatedAt' | 'severity' | 'retryCount';
type SortOrder = 'asc' | 'desc';

export function PartialFailureDashboard() {
  const [failures, setFailures] = useState<PartialFailure[]>([]);
  const [report, setReport] = useState<FailureReport | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    status: 'unresolved',
    severity: 'all',
    operationType: 'all',
    maxAge: 'all',
    searchTerm: '',
  });
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    refreshData();
    // Poll for updates every 30 seconds
    const interval = setInterval(refreshData, 30000);
    return () => clearInterval(interval);
  }, []);

  const refreshData = () => {
    setFailures(partialFailureTracker.getAllFailures());
    setReport(partialFailureTracker.generateReport());
  };

  const filteredFailures = useMemo(() => {
    return failures
      .filter((failure) => {
        // Status filter
        if (filters.status !== 'all' && failure.status !== filters.status) {
          return false;
        }

        // Severity filter
        if (filters.severity !== 'all' && failure.severity !== filters.severity) {
          return false;
        }

        // Operation type filter
        if (filters.operationType !== 'all' && failure.operationType !== filters.operationType) {
          return false;
        }

        // Age filter
        if (filters.maxAge !== 'all') {
          const age = Date.now() - new Date(failure.createdAt).getTime();
          if (age > filters.maxAge) {
            return false;
          }
        }

        // Search term filter
        if (filters.searchTerm) {
          const searchLower = filters.searchTerm.toLowerCase();
          const searchableText = [
            failure.operationId,
            failure.errorMessage,
            failure.internalState.resourceId as string,
            failure.externalRefId,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!searchableText.includes(searchLower)) {
            return false;
          }
        }

        return true;
      })
      .sort((a, b) => {
        let comparison = 0;

        switch (sortField) {
          case 'createdAt':
            comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            break;
          case 'updatedAt':
            comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
            break;
          case 'severity':
            const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
            comparison = severityOrder[a.severity] - severityOrder[b.severity];
            break;
          case 'retryCount':
            comparison = a.retryCount - b.retryCount;
            break;
        }

        return sortOrder === 'asc' ? comparison : -comparison;
      });
  }, [failures, filters, sortField, sortOrder]);

  const handleRetry = async (failureId: string) => {
    try {
      partialFailureTracker.retryFailure(failureId);
      setMessage({ type: 'success', text: 'Failure queued for retry' });
      refreshData();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Retry failed' });
    }
    setTimeout(() => setMessage(null), 5000);
  };

  const handleResolve = (failureId: string, notes?: string) => {
    try {
      partialFailureTracker.markResolved(failureId, notes);
      setMessage({ type: 'success', text: 'Failure marked as resolved' });
      refreshData();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Resolution failed' });
    }
    setTimeout(() => setMessage(null), 5000);
  };

  const handleManualIntervention = (failureId: string, notes?: string) => {
    try {
      partialFailureTracker.markManualIntervention(failureId, notes);
      setMessage({ type: 'success', text: 'Failure marked for manual intervention' });
      refreshData();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Operation failed' });
    }
    setTimeout(() => setMessage(null), 5000);
  };

  const handleIgnore = (failureId: string, reason?: string) => {
    try {
      partialFailureTracker.ignoreFailure(failureId, reason);
      setMessage({ type: 'success', text: 'Failure ignored' });
      refreshData();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Ignore failed' });
    }
    setTimeout(() => setMessage(null), 5000);
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const getSeverityColor = (severity: FailureSeverity) => {
    switch (severity) {
      case 'critical':
        return 'text-red-300 bg-red-500/10 border-red-500/30';
      case 'high':
        return 'text-orange-300 bg-orange-500/10 border-orange-500/30';
      case 'medium':
        return 'text-yellow-300 bg-yellow-500/10 border-yellow-500/30';
      case 'low':
        return 'text-green-300 bg-green-500/10 border-green-500/30';
    }
  };

  const getStatusColor = (status: FailureStatus) => {
    switch (status) {
      case 'unresolved':
        return 'text-gray-300 bg-gray-500/10 border-gray-500/30';
      case 'retrying':
        return 'text-blue-300 bg-blue-500/10 border-blue-500/30';
      case 'resolved':
        return 'text-green-300 bg-green-500/10 border-green-500/30';
      case 'manual_intervention':
        return 'text-purple-300 bg-purple-500/10 border-purple-500/30';
    }
  };

  const formatAge = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const requiresUserAction = (failure: PartialFailure) => {
    return (
      failure.status === 'manual_intervention' ||
      failure.severity === 'critical' ||
      failure.retryCount >= failure.maxRetries
    );
  };

  if (!mounted) {
    return <div className="text-gray-300">Loading dashboard...</div>;
  }

  return (
    <div className="space-y-6" data-testid="partial-failure-dashboard">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Partial Failure Dashboard</h1>
        <p className="mt-1 text-sm text-gray-400">
          Monitor and manage unresolved partial failures from async jobs, integrations, and user-visible operations.
        </p>
      </div>

      {/* Message Banner */}
      {message && (
        <div
          role="alert"
          aria-live={message.type === 'error' ? 'assertive' : 'polite'}
          className={`rounded-md border p-3 text-sm ${
            message.type === 'success'
              ? 'border-green-500/50 bg-green-500/10 text-green-200'
              : 'border-red-500/50 bg-red-500/10 text-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Summary Cards */}
      {report && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-4">
            <p className="text-sm text-gray-300">Total Failures</p>
            <p className="mt-2 text-3xl font-bold text-white">{report.totalFailures}</p>
          </div>
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
            <p className="text-sm text-gray-300">Critical</p>
            <p className="mt-2 text-3xl font-bold text-red-300">{report.bySeverity.critical}</p>
          </div>
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-4">
            <p className="text-sm text-gray-300">Retrying</p>
            <p className="mt-2 text-3xl font-bold text-blue-300">{report.byStatus.retrying}</p>
          </div>
          <div className="rounded-lg border border-purple-500/30 bg-purple-500/10 p-4">
            <p className="text-sm text-gray-300">Manual Intervention</p>
            <p className="mt-2 text-3xl font-bold text-purple-300">{report.byStatus.manual_intervention}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label htmlFor="status-filter" className="block text-xs uppercase tracking-wide text-gray-400">
              Status
            </label>
            <select
              id="status-filter"
              className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm text-white"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value as FailureStatus | 'all' })}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="text-black">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="severity-filter" className="block text-xs uppercase tracking-wide text-gray-400">
              Severity
            </label>
            <select
              id="severity-filter"
              className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm text-white"
              value={filters.severity}
              onChange={(e) => setFilters({ ...filters, severity: e.target.value as FailureSeverity | 'all' })}
            >
              {SEVERITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="text-black">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="type-filter" className="block text-xs uppercase tracking-wide text-gray-400">
              Operation Type
            </label>
            <select
              id="type-filter"
              className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm text-white"
              value={filters.operationType}
              onChange={(e) => setFilters({ ...filters, operationType: e.target.value as OperationType | 'all' })}
            >
              {OPERATION_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="text-black">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="age-filter" className="block text-xs uppercase tracking-wide text-gray-400">
              Age
            </label>
            <select
              id="age-filter"
              className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm text-white"
              value={filters.maxAge}
              onChange={(e) => setFilters({ ...filters, maxAge: e.target.value === 'all' ? 'all' : Number(e.target.value) })}
            >
              {AGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="text-black">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="search-filter" className="block text-xs uppercase tracking-wide text-gray-400">
              Search
            </label>
            <input
              id="search-filter"
              type="text"
              className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm text-white placeholder-gray-500"
              placeholder="Search by ID, error, or resource..."
              value={filters.searchTerm}
              onChange={(e) => setFilters({ ...filters, searchTerm: e.target.value })}
            />
          </div>
        </div>
      </div>

      {/* Failure List */}
      <div className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10">
        {/* Table Header */}
        <div className="grid grid-cols-12 gap-2 border-b border-trellis-vine/30 p-3 text-xs uppercase tracking-wide text-gray-400">
          <button
            type="button"
            aria-sort={sortField === 'createdAt' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}
            className="col-span-2 flex items-center gap-1 hover:text-white focus:outline-none focus:ring-2 focus:ring-trellis-leaf rounded"
            onClick={() => handleSort('createdAt')}
          >
            Created
            {sortField === 'createdAt' && <span aria-hidden="true">{sortOrder === 'asc' ? '↑' : '↓'}</span>}
          </button>
          <button
            type="button"
            aria-sort={sortField === 'severity' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}
            className="col-span-2 flex items-center gap-1 hover:text-white focus:outline-none focus:ring-2 focus:ring-trellis-leaf rounded"
            onClick={() => handleSort('severity')}
          >
            Severity
            {sortField === 'severity' && <span aria-hidden="true">{sortOrder === 'asc' ? '↑' : '↓'}</span>}
          </button>
          <div className="col-span-2">Type</div>
          <div className="col-span-3">Operation ID</div>
          <div className="col-span-1">Retries</div>
          <div className="col-span-2">Actions</div>
        </div>

        {/* Table Body */}
        {filteredFailures.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No failures match the current filters.
          </div>
        ) : (
          <div className="divide-y divide-trellis-vine/30">
            {filteredFailures.map((failure) => (
              <div key={failure.id} className="p-3">
                <div className="grid grid-cols-12 gap-2 items-center">
                  {/* Created */}
                  <div className="col-span-2 text-sm text-gray-300">{formatAge(failure.createdAt)}</div>

                  {/* Severity */}
                  <div className="col-span-2">
                    <span
                      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${getSeverityColor(failure.severity)}`}
                    >
                      {failure.severity}
                    </span>
                  </div>

                  {/* Type */}
                  <div className="col-span-2 text-sm text-gray-300">{failure.operationType}</div>

                  {/* Operation ID */}
                  <div className="col-span-3 text-sm text-gray-300 truncate" title={failure.operationId}>
                    {failure.operationId}
                  </div>

                  {/* Retries */}
                  <div className="col-span-1 text-sm text-gray-300">
                    {failure.retryCount}/{failure.maxRetries}
                  </div>

                  {/* Actions */}
                  <div className="col-span-2 flex gap-2">
                    <button
                      type="button"
                      className="rounded border border-trellis-vine/60 px-2 py-1 text-xs text-white hover:bg-trellis-vine/20 focus:outline-none focus:ring-2 focus:ring-trellis-leaf"
                      aria-expanded={expanded === failure.id}
                      aria-controls={`failure-details-${failure.id}`}
                      onClick={() => setExpanded(expanded === failure.id ? null : failure.id)}
                    >
                      {expanded === failure.id ? 'Hide' : 'Inspect'}
                    </button>
                    {failure.canRetry && failure.retryCount < failure.maxRetries && (
                      <button
                        type="button"
                        className="rounded bg-trellis-leaf px-2 py-1 text-xs font-semibold text-black hover:bg-trellis-leaf/80 focus:outline-none focus:ring-2 focus:ring-trellis-leaf"
                        onClick={() => handleRetry(failure.id)}
                        aria-label={`Retry ${failure.operationId}`}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </div>

                {/* User Action Required Indicator */}
                {requiresUserAction(failure) && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-orange-300">
                    <span className="h-2 w-2 rounded-full bg-orange-400" aria-hidden="true" />
                    <span>Requires user action</span>
                  </div>
                )}

                {/* Expanded Details */}
                {expanded === failure.id && (
                  <div
                    id={`failure-details-${failure.id}`}
                    role="region"
                    aria-label={`Details for ${failure.operationId}`}
                    className="mt-3 space-y-3 rounded-lg bg-black/40 p-4"
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <p className="text-xs text-gray-400">Status</p>
                        <span
                          className={`inline-block mt-1 rounded-full border px-2 py-0.5 text-xs font-medium ${getStatusColor(failure.status)}`}
                        >
                          {failure.status}
                        </span>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400">External Reference</p>
                        <p className="mt-1 text-sm text-gray-300">{failure.externalRefId || 'N/A'}</p>
                      </div>
                      <div className="sm:col-span-2">
                        <p className="text-xs text-gray-400">Error Message</p>
                        <p className="mt-1 text-sm text-red-300">{failure.errorMessage}</p>
                      </div>
                      {failure.resolutionNotes && (
                        <div className="sm:col-span-2">
                          <p className="text-xs text-gray-400">Resolution Notes</p>
                          <p className="mt-1 text-sm text-gray-300">{failure.resolutionNotes}</p>
                        </div>
                      )}
                      {failure.nextRetryAt && (
                        <div>
                          <p className="text-xs text-gray-400">Next Retry</p>
                          <p className="mt-1 text-sm text-gray-300">{new Date(failure.nextRetryAt).toLocaleString()}</p>
                        </div>
                      )}
                      {failure.deadLetterId && (
                        <div>
                          <p className="text-xs text-gray-400">Dead Letter ID</p>
                          <p className="mt-1 text-sm text-gray-300">{failure.deadLetterId}</p>
                        </div>
                      )}
                    </div>

                    {/* Internal State */}
                    <div>
                      <p className="text-xs text-gray-400">Internal State</p>
                      <pre className="mt-1 max-h-48 overflow-auto rounded bg-black/60 p-3 text-xs text-gray-300">
                        {JSON.stringify(failure.internalState, null, 2)}
                      </pre>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-wrap gap-2">
                      {failure.status !== 'resolved' && (
                        <button
                          type="button"
                          className="rounded border border-green-500/60 px-3 py-1.5 text-xs text-green-200 hover:bg-green-500/10 focus:outline-none focus:ring-2 focus:ring-green-300"
                          onClick={() => handleResolve(failure.id, 'Resolved by operator')}
                        >
                          Mark Resolved
                        </button>
                      )}
                      {failure.status !== 'manual_intervention' && (
                        <button
                          type="button"
                          className="rounded border border-purple-500/60 px-3 py-1.5 text-xs text-purple-200 hover:bg-purple-500/10 focus:outline-none focus:ring-2 focus:ring-purple-300"
                          onClick={() => handleManualIntervention(failure.id, 'Marked for manual review')}
                        >
                          Manual Intervention
                        </button>
                      )}
                      {failure.canIgnore && (
                        <button
                          type="button"
                          className="rounded border border-yellow-500/60 px-3 py-1.5 text-xs text-yellow-200 hover:bg-yellow-500/10 focus:outline-none focus:ring-2 focus:ring-yellow-300"
                          onClick={() => handleIgnore(failure.id, 'Ignored by operator')}
                        >
                          Ignore
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="text-xs text-gray-500">
        Showing {filteredFailures.length} of {failures.length} total failures. Last updated {new Date().toLocaleString()}.
      </div>
    </div>
  );
}
