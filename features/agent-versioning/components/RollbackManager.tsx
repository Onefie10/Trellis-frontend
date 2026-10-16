import React, { useState } from 'react';
import { VersionMetadata } from '../types';

interface RollbackManagerProps {
  currentVersion: string;
  history: VersionMetadata[];
  onRollback: (targetVersion: string, contractId: string) => void;
}

export interface RollbackRecord {
  id: string;
  fromVersion: string;
  toVersion: string;
  contractId: string;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed';
  attempts: number;
  lastError?: string;
}

export const ROLLBACK_HISTORY_KEY = 'trellis.rollbackHistory.v1';

const MAX_ATTEMPTS = 3;

function safeParseHistory(raw: string | null): RollbackRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RollbackRecord =>
        r && typeof r === 'object' && typeof r.id === 'string' && typeof r.toVersion === 'string',
    );
  } catch {
    return [];
  }
}

export function loadRollbackHistory(): RollbackRecord[] {
  if (typeof window === 'undefined') return [];
  return safeParseHistory(window.localStorage.getItem(ROLLBACK_HISTORY_KEY));
}

function persistRollbackHistory(records: RollbackRecord[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ROLLBACK_HISTORY_KEY, JSON.stringify(records.slice(0, 50)));
  } catch {
    /* storage full or unavailable - history is best-effort only */
  }
}

export const RollbackManager: React.FC<RollbackManagerProps> = ({ currentVersion, history, onRollback }) => {
  const [selectedVersion, setSelectedVersion] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [records, setRecords] = useState<RollbackRecord[]>(() => loadRollbackHistory());
  const [error, setError] = useState<string | null>(null);

  // Only allow rolling back to previous stable versions
  const stableVersions = history.filter(v => v.status === 'stable' && v.version !== currentVersion);

  const target = stableVersions.find(v => v.version === selectedVersion);
  const confirmationPhrase = target ? `ROLLBACK to v:${target.version}` : '';
  const confirmed = confirmText.trim() === confirmationPhrase && confirmationPhrase !== '';

  const updateRecord = (id: string, patch: Partial<RollbackRecord>) => {
    setRecords((prev) => {
      const next = prev.map(r => (r.id === id ? { ...r, ...patch } : r));
      persistRollbackHistory(next);
      return next;
    });
  };

  const executeRollback = () => {
    setError(null);
    if (!target) {
      setError('Select a stable target version before executing a rollback.');
      return;
    }
    if (!confirmed) {
      setError(`Type "${confirmationPhrase}" exactly to confirm this rollback.`);
      return;
    }

    const record: RollbackRecord = {
      id: `${Date.now()}-${target.version}`,
      fromVersion: currentVersion,
      toVersion: target.version,
      contractId: target.contractId,
      timestamp: Date.now(),
      status: 'pending',
      attempts: 1,
    };

    setRecords((prev) => {
      const next = [record, ...prev].slice(0, 50);
      persistRollbackHistory(next);
      return next;
    });

    try {
      onRollback(target.version, target.contractId);
      updateRecord(record.id, { status: 'confirmed' });
      setSelectedVersion('');
      setConfirmText('');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown rollback failure';
      updateRecord(record.id, { status: 'failed', lastError: message });
      setError(`Rollback failed: ${message}. Retry or verify the contract pointer manually.`);
    }
  };

  const retryRollback = (record: RollbackRecord) => {
    if (record.attempts >= MAX_ATTEMPTX) {
      setError(`Rollback to v${record.toVersion} exhausted ${MAX_ATTEMPTS} attempts. Escalate to on-call and verify the contract pointer manually.`);
      return;
    }
    setError(null);
    try {
      onRollback(record.toVersion, record.contractId);
      updateRecord(record.id, {
        status: 'confirmed',
        attempts: record.attempts + 1,
        lastError: undefined,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown rollback failure';
      updateRecord(record.id, {
        status: 'failed',
        attempts: record.attempts + 1,
        lastError: message,
      });
      setError(`Retry failed: ${message}.`);
    }
  };

  return (
    <div className="bg-slate-900 border border-red-500/30 rounded-xl p-6 shadow-[0_0_15px_rgba(239,68,68,0.15)] text-white relative overflow-hidden">
      {/* Warning Stripes Background */}
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-600 via-orange-500 to-red-600"></div>

      <h2 className="text-2xl font-bold mb-2 text-red-400 flex items-center gap-2">
        <span>⚠️</span> Emergency Rollback
      </h2>
      <p className="text-sm text-slate-400 mb-6">
        Instantly revert the active agent pointer to a previous stable contract version. Use only in case of critical failure in the current version (v{currentVersion}).
      </p>

      <div className="bg-slate-800/50 p-4 rounded-lg border border-red-900/50 flex flex-col gap-4">
        <div className="flex flex-col md-flex-row items-end gap-4">
          <div className="flex-1 w-full">
            <label className="block text-sm font-medium text-slate-300 mb-2" htmlFor="rollback-version-select">Select Stable Target Version</label>
            <select
              id="rollback-version-select"
              className="w-full bg-[#090b14] border border-slate-600 rounded px-3 py-2 text-white focus:outline-none focus:border-red-500"
              value={selectedVersion}
              onChange={(e) => {
                setSelectedVersion(e.target.value);
                setConfirmText('');
                setError(null);
              }}
            >
              <option value="" disabled>-- Select a version --</option>
              {stableVersions.map(v => (
                <option key={v.version} value={v.version}>v{v.version} (Deployed: {new Date(v.timestamp).toLocaleDateString()})</option>
              ))}
            </select>
          </div>
        </div>

        {target && (
          <div className="bg-slate-900/70 border border-slate-700 rounded p-3 text-sm">
            <p className="text-slate-300 mb-2">
              Type <code className="bg-black/40 px-1 rounded text-red-300">{confirmationPhrase}</code> to confirm. This will update the active Soroban contract pointer to <code className="bg-black/40 px-1 rounded">{target.contractId}</code>.
            </p>
            <label className="block text-xs font-medium text-slate-400 mb-1" htmlFor="rollback-confirm-input">Confirmation</label>
            <input
              id="rollback-confirm-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-[#090b14] border border-slate-600 rounded px-3 py-2 text-white focus:outline-none focus:border-red-500"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={confirmationPhrase}
            />
          </div>
        )}

        {error && (
          <div role="alert" className="bg-red-950/40 border border-red-700 text-red-200 rounded p-3 text-sm">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={executeRollback}
          disabled={!target || !confirmed}
          className="px-6 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded font-bold shadow-[0_0_15px_rgba(239,68,68,0.4)] transition-all">
          EXECUTE ROLLBACK
        </button>
      </div>

      <div className="mt-6">
        <h3 className="text-lg font-semibold text-slate-200 mb-2">Rollback Audit Trail</h3>
        {records.length === 0 ? (
          <p className="text-sm text-slate-500">No rollbacks recorded yet.</p>
        ) : (
          <ul className="space-2">
            {records.map(r => (
              <li key={r.id} className="bg-slate-800/40 border border-slate-700 rounded p-3 text-sm flex flex-col md-flex-row md-items-center md-justify-between gap-2">
                <div className="flex flex-col">
                  <span className="text-slate-200">
                    v{r.fromVersion} → v- {r.toVersion} <span className="text-slate-500">({r.contractId})</span>
                  </span>
                  <span className="text-xs text-slate-500">
                    {new Date(r.timestamp).toLocaleString()} — attempts {r.attempts}
                  </span>
                  {r.lastError && (
                    <span className="text-xs text-red-300">{`Last error: ${r.lastError}`}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={
                      r.status === 'confirmed'
                        ? 'text-emerald-400'
                        : r.status === 'failed'
                        ? 'text-red-400'
                        : 'text-amber-400'
                    }
                  >
                    {r.status}
                  </span>
                  {r.status === 'failed' && (
                    <button
                      type="button"
                      onClick={() => retryRollback(r)}
                      disabled={r.attempts >= MAX_ATTEMPTS}
                      className="px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed rounded text-xs"
                    >
                      Retry
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6 text-xs text-slate-500 space-y-1">
        <p>
          <strong className="text-slate-400">Rollback guidance:</strong> if a rollback fails, retry up to {MAX_ATTEMPTS} times. After that, escalate to on-call and verify the active contract pointer manually before attempting any further changes.
        </p>
        <p>
          <strong className="text-slate-400">Edge cases:</strong> confirmation is required to prevent accidental rollbacks; the audit trail is persisted locally and capped at 50 entries.
        </p>
      </div>
    </div>
  );
};
