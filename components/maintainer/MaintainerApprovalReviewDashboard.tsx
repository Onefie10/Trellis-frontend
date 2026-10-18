'use client';

import React, { useState } from 'react';
import {
  type SignedIntentReceipt,
  type MaintainerAuditReceiptLog,
  type MaintainerActor,
  type IntentApprovalStatus,
  type HighImpactMaintainerAction,
  HIGH_IMPACT_MAINTAINER_ACTIONS,
} from '@/lib/maintainer-approvals/types';
import { MaintainerApprovalService } from '@/lib/maintainer-approvals/service';
import { MaintainerActionApprovalModal } from './MaintainerActionApprovalModal';

export interface MaintainerApprovalReviewDashboardProps {
  reviewer: MaintainerActor;
  service?: MaintainerApprovalService;
  isOffline?: boolean;
}

export function MaintainerApprovalReviewDashboard({
  reviewer,
  service = new MaintainerApprovalService(),
  isOffline = false,
}: MaintainerApprovalReviewDashboardProps) {
  const [receipts, setReceipts] = useState<SignedIntentReceipt[]>(() => service.listReceipts());
  const [selectedReceipt, setSelectedReceipt] = useState<SignedIntentReceipt | null>(null);
  const [auditLogs, setAuditLogs] = useState<MaintainerAuditReceiptLog[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);

  const refreshReceipts = () => {
    const filters: { status?: IntentApprovalStatus; action?: HighImpactMaintainerAction } = {};
    if (statusFilter !== 'all') filters.status = statusFilter as IntentApprovalStatus;
    if (actionFilter !== 'all') filters.action = actionFilter as HighImpactMaintainerAction;
    setReceipts(service.listReceipts(filters));
  };

  const handleSelectReceipt = (rcpt: SignedIntentReceipt) => {
    setSelectedReceipt(rcpt);
    setAuditLogs(service.getAuditTrail(rcpt.receiptId));
    setFeedback(null);
  };

  const handleExecute = async (rcpt: SignedIntentReceipt) => {
    setExecutingId(rcpt.receiptId);
    setFeedback(null);
    try {
      const updated = await service.executeApprovedAction(rcpt.receiptId, async () => {
        // Simulate execution
        return {
          externalTxRef: `tx-stellar-${Math.random().toString(36).substring(2, 10)}`,
          result: { success: true, executedBy: reviewer.id, timestamp: Date.now() },
        };
      });
      setSelectedReceipt(updated);
      refreshReceipts();
      setFeedback(`Successfully executed ${rcpt.action}. External Tx Ref recorded.`);
    } catch (err) {
      setFeedback(`Execution failed: ${err instanceof Error ? err.message : String(err)}`);
      refreshReceipts();
    } finally {
      setExecutingId(null);
    }
  };

  const handleRollback = (rcpt: SignedIntentReceipt) => {
    try {
      const updated = service.rollbackAction(rcpt.receiptId, reviewer, 'Manual rollback by maintainer review');
      setSelectedReceipt(updated);
      refreshReceipts();
      setFeedback(`Action ${rcpt.action} marked as rolled back with compensatory receipt.`);
    } catch (err) {
      setFeedback(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSyncOffline = async () => {
    setFeedback('Synchronizing offline intent queue…');
    const res = await service.syncOfflineQueue(async () => {
      return {
        externalTxRef: `tx-synced-${Math.random().toString(36).substring(2, 8)}`,
        result: { syncedAt: Date.now() },
      };
    });
    refreshReceipts();
    setFeedback(`Sync completed: ${res.synced.length} synced, ${res.failed.length} failed.`);
  };

  return (
    <div className="w-full space-y-6 text-zinc-100" data-testid="maintainer-review-dashboard">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <span>Maintainer Approvals & Intent Receipts</span>
            {isOffline && (
              <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300 font-normal">
                Offline Mode
              </span>
            )}
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Review explicit intent receipts, verify Ed25519 signatures, audit historical executions, and trigger rollbacks.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isOffline && (
            <button
              onClick={handleSyncOffline}
              className="rounded-lg border border-amber-500/50 bg-amber-950/20 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-900/40"
            >
              Sync Offline Queue
            </button>
          )}
          <button
            onClick={() => setIsModalOpen(true)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-md hover:bg-emerald-500"
          >
            + New High-Impact Intent
          </button>
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3 text-xs text-emerald-300"
        >
          {feedback}
        </div>
      )}

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center gap-3 bg-zinc-900/50 p-3 rounded-xl border border-zinc-800 text-xs">
        <label className="text-zinc-400">Filters:</label>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setTimeout(refreshReceipts, 0);
          }}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-zinc-200"
        >
          <option value="all">All Statuses</option>
          <option value="approved">approved</option>
          <option value="queued_offline">queued_offline</option>
          <option value="executing">executing</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="rolled_back">rolled_back</option>
        </select>

        <select
          value={actionFilter}
          onChange={(e) => {
            setActionFilter(e.target.value);
            setTimeout(refreshReceipts, 0);
          }}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-zinc-200"
        >
          <option value="all">All Actions</option>
          {HIGH_IMPACT_MAINTAINER_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {/* Main Review Section */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Receipts List */}
        <div className="lg:col-span-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Signed Intent Receipts ({receipts.length})
          </h2>

          {receipts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-xs text-zinc-500">
              No signed intent receipts matching filters.
            </div>
          ) : (
            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
              {receipts.map((rcpt) => {
                const isSelected = selectedReceipt?.receiptId === rcpt.receiptId;
                return (
                  <div
                    key={rcpt.receiptId}
                    onClick={() => handleSelectReceipt(rcpt)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => e.key === 'Enter' && handleSelectReceipt(rcpt)}
                    className={`cursor-pointer rounded-xl border p-4 transition ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-950/20'
                        : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-xs text-zinc-200">{rcpt.action}</span>
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase ${
                          rcpt.status === 'completed'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : rcpt.status === 'failed'
                            ? 'bg-rose-500/20 text-rose-300'
                            : rcpt.status === 'queued_offline'
                            ? 'bg-amber-500/20 text-amber-300'
                            : rcpt.status === 'rolled_back'
                            ? 'bg-purple-500/20 text-purple-300'
                            : 'bg-blue-500/20 text-blue-300'
                        }`}
                      >
                        {rcpt.status}
                      </span>
                    </div>

                    <div className="mt-2 text-[11px] text-zinc-400 font-mono truncate">
                      ID: {rcpt.receiptId}
                    </div>

                    <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
                      <span>{rcpt.environment}</span>
                      <span>{new Date(rcpt.createdAt).toLocaleTimeString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected Receipt Detail & Post-Review Actions */}
        <div className="lg:col-span-7">
          {selectedReceipt ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/90 p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    Intent Receipt Details
                  </h3>
                  <p className="text-xs font-mono text-zinc-400">
                    {selectedReceipt.receiptId}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {(selectedReceipt.status === 'approved' || selectedReceipt.status === 'queued_offline') && (
                    <button
                      onClick={() => handleExecute(selectedReceipt)}
                      disabled={executingId === selectedReceipt.receiptId}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {executingId === selectedReceipt.receiptId ? 'Executing…' : 'Execute Intent'}
                    </button>
                  )}

                  {(selectedReceipt.status === 'completed' || selectedReceipt.status === 'failed') && (
                    <button
                      onClick={() => handleRollback(selectedReceipt)}
                      className="rounded-lg border border-purple-500/50 bg-purple-950/20 px-3 py-1.5 text-xs font-semibold text-purple-300 hover:bg-purple-900/40"
                    >
                      Compensate / Rollback
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-zinc-500 block">Impact Classification</span>
                  <span className="font-semibold text-zinc-200">{selectedReceipt.impactLevel}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block">Maintainer Public Key</span>
                  <span className="font-mono text-zinc-300 truncate block">
                    {selectedReceipt.maintainer.publicKey}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block">Intent Fingerprint</span>
                  <span className="font-mono text-zinc-300 truncate block">
                    {selectedReceipt.intentFingerprint}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block">External Reference</span>
                  <span className="font-mono text-zinc-300 truncate block">
                    {selectedReceipt.externalTxRef ?? 'None (Not submitted on-chain)'}
                  </span>
                </div>
              </div>

              {selectedReceipt.failureReason && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-300">
                  <span className="font-semibold block mb-0.5">Failure Diagnostic:</span>
                  {selectedReceipt.failureReason}
                </div>
              )}

              {/* Canonical Payload */}
              <div>
                <label className="text-xs font-semibold text-zinc-400 block mb-1">
                  Canonical Signed Intent (RFC 8785)
                </label>
                <pre className="max-h-36 overflow-y-auto rounded-lg bg-zinc-950 p-3 text-[11px] font-mono text-zinc-300 border border-zinc-800">
                  {selectedReceipt.canonicalIntentJson}
                </pre>
              </div>

              {/* Audit Log Timeline */}
              <div>
                <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                  Review Audit Trail
                </h4>
                {auditLogs.length === 0 ? (
                  <p className="text-xs text-zinc-500">No audit logs recorded for this receipt.</p>
                ) : (
                  <div className="space-y-2 border-l-2 border-zinc-800 pl-3">
                    {auditLogs.map((log) => (
                      <div key={log.logId} className="text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-200">{log.status}</span>
                          <span className="text-[10px] text-zinc-500">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-400">
                          Actor: <code className="font-mono text-zinc-300">{log.actor.id}</code> ({log.actor.role})
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-zinc-800 p-12 text-center text-xs text-zinc-500">
              Select a signed intent receipt to review details, verify cryptographic signatures, and inspect the audit trail.
            </div>
          )}
        </div>
      </div>

      <MaintainerActionApprovalModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          refreshReceipts();
        }}
        maintainer={reviewer}
        service={service}
        isOffline={isOffline}
        onApproved={(newReceipt) => {
          refreshReceipts();
          handleSelectReceipt(newReceipt);
        }}
      />
    </div>
  );
}
