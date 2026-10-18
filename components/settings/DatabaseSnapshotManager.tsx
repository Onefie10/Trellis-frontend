'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  exportDatabaseSnapshot,
  restoreDatabaseSnapshot,
  listOfflineDrafts,
  saveOfflineDraft,
  deleteOfflineDraft,
  type RestoreResult,
} from '@/lib/cache-manager';
import { toast } from 'sonner';

export default function DatabaseSnapshotManager() {
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<RestoreResult | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<Array<{ id: string; data: unknown }>>([]);
  const [testDraftTitle, setTestDraftTitle] = useState('');
  const [isLoadingDrafts, setIsLoadingDrafts] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshDrafts = async () => {
    setIsLoadingDrafts(true);
    try {
      const list = await listOfflineDrafts();
      setDrafts(list);
    } catch (err) {
      console.error('Failed to list drafts:', err);
    } finally {
      setIsLoadingDrafts(false);
    }
  };

  useEffect(() => {
    void refreshDrafts();
  }, []);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const snapshotJson = await exportDatabaseSnapshot({
        passphrase: exportPassphrase.trim() ? exportPassphrase : undefined,
      });

      const blob = new Blob([snapshotJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trellis-database-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(
        exportPassphrase.trim()
          ? 'Encrypted database snapshot exported successfully'
          : 'Database snapshot exported successfully'
      );
    } catch (err: any) {
      console.error('Export error:', err);
      toast.error(`Export failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setRestoreStatus(null);
      setRestoreError(null);
    }
  };

  const handleRestore = async () => {
    if (!selectedFile) {
      toast.error('Please select a snapshot JSON file to restore');
      return;
    }

    setIsRestoring(true);
    setRestoreStatus(null);
    setRestoreError(null);

    try {
      const fileText = await selectedFile.text();
      const result = await restoreDatabaseSnapshot(fileText, {
        passphrase: importPassphrase.trim() ? importPassphrase : undefined,
        overwrite: true,
      });

      setRestoreStatus(result);
      toast.success(
        `Successfully restored ${result.restoredDatabases} database(s), ${result.restoredStores} store(s), and ${result.restoredRecords} record(s)`
      );
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setSelectedFile(null);
      setImportPassphrase('');
      await refreshDrafts();
    } catch (err: any) {
      console.error('Restore error:', err);
      const message = err?.message || 'Failed to restore snapshot';
      setRestoreError(message);
      toast.error(`Restore failed: ${message}`);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleCreateTestDraft = async () => {
    const title = testDraftTitle.trim() || `Offline draft #${drafts.length + 1}`;
    const id = `draft-${Date.now()}`;
    const draftData = {
      id,
      title,
      content: 'This draft was saved offline and can be migrated using snapshot export/restore.',
      createdAt: new Date().toISOString(),
    };

    try {
      await saveOfflineDraft(id, draftData);
      setTestDraftTitle('');
      toast.success(`Created draft "${title}"`);
      await refreshDrafts();
    } catch (err: any) {
      toast.error(`Failed to create draft: ${err?.message || 'Unknown error'}`);
    }
  };

  const handleDeleteDraft = async (id: string) => {
    try {
      await deleteOfflineDraft(id);
      toast.success('Draft removed');
      await refreshDrafts();
    } catch (err: any) {
      toast.error(`Failed to delete draft: ${err?.message || 'Unknown error'}`);
    }
  };

  return (
    <section
      data-testid="database-snapshot-manager"
      className="space-y-6 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 backdrop-blur"
    >
      <div>
        <h2 className="text-2xl font-bold text-white">IndexedDB Snapshot & Offline State Migration</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Export full IndexedDB database snapshots to encrypted JSON backup files or restore state across browser
          profiles to preserve offline drafts, telemetry logs, and local application cache.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Export Card */}
        <div className="flex flex-col justify-between rounded-xl border border-neutral-800 bg-neutral-950/70 p-5">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                ↓
              </span>
              <h3 className="font-semibold text-white">Export Database Snapshot</h3>
            </div>
            <p className="text-xs text-neutral-400">
              Dumps all IndexedDB object stores (cached metadata, offline drafts, telemetry) into a downloadable JSON file.
            </p>

            <div className="space-y-1.5">
              <label htmlFor="export-passphrase" className="text-xs font-medium text-neutral-300">
                Encryption Passphrase (Optional)
              </label>
              <input
                id="export-passphrase"
                type="password"
                value={exportPassphrase}
                onChange={(e) => setExportPassphrase(e.target.value)}
                placeholder="Optional passphrase (AES-GCM-256)"
                className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:border-emerald-500 focus:outline-none"
              />
              <span className="text-[11px] text-neutral-500">
                Leaving blank creates a standard validated snapshot; adding a passphrase encrypts the payload.
              </span>
            </div>
          </div>

          <div className="mt-5">
            <button
              type="button"
              onClick={handleExport}
              disabled={isExporting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isExporting ? 'Exporting…' : 'Export Snapshot (.json)'}
            </button>
          </div>
        </div>

        {/* Restore Card */}
        <div className="flex flex-col justify-between rounded-xl border border-neutral-800 bg-neutral-950/70 p-5">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
                ↑
              </span>
              <h3 className="font-semibold text-white">Restore Database Snapshot</h3>
            </div>
            <p className="text-xs text-neutral-400">
              Imports a snapshot file, validates structural schema integrity and checksums, and reinstates local state.
            </p>

            <div className="space-y-1.5">
              <label htmlFor="snapshot-file" className="text-xs font-medium text-neutral-300">
                Snapshot File (.json)
              </label>
              <input
                ref={fileInputRef}
                id="snapshot-file"
                type="file"
                accept=".json,application/json"
                onChange={handleFileChange}
                className="w-full text-xs text-neutral-400 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-neutral-700"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="import-passphrase" className="text-xs font-medium text-neutral-300">
                Decryption Passphrase
              </label>
              <input
                id="import-passphrase"
                type="password"
                value={importPassphrase}
                onChange={(e) => setImportPassphrase(e.target.value)}
                placeholder="Required if backup was encrypted"
                className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:border-sky-500 focus:outline-none"
              />
            </div>

            {restoreStatus && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-300">
                ✓ Restored {restoreStatus.restoredDatabases} database(s), {restoreStatus.restoredStores} store(s), and {restoreStatus.restoredRecords} record(s).
              </div>
            )}

            {restoreError && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                ✕ {restoreError}
              </div>
            )}
          </div>

          <div className="mt-5">
            <button
              type="button"
              onClick={handleRestore}
              disabled={isRestoring || !selectedFile}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRestoring ? 'Restoring…' : 'Restore Snapshot'}
            </button>
          </div>
        </div>
      </div>

      {/* Offline Drafts Preview & Testing Manager */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-950/70 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-white">Offline Drafts & Local State</h3>
            <p className="text-xs text-neutral-400">
              Manage local drafts to verify backup and restore fidelity across sessions.
            </p>
          </div>
          <button
            type="button"
            onClick={refreshDrafts}
            disabled={isLoadingDrafts}
            className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800"
          >
            {isLoadingDrafts ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={testDraftTitle}
            onChange={(e) => setTestDraftTitle(e.target.value)}
            placeholder="New draft title (e.g. My Offline Proposal)"
            className="flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-white placeholder-neutral-500 focus:border-neutral-600 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleCreateTestDraft}
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700"
          >
            Add Draft
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {drafts.length === 0 ? (
            <p className="text-xs italic text-neutral-500">No offline drafts stored in IndexedDB.</p>
          ) : (
            drafts.map((draft) => {
              const data = (draft.data as any) || {};
              return (
                <div
                  key={draft.id}
                  className="flex items-center justify-between rounded-lg border border-neutral-800/80 bg-neutral-900/40 px-3 py-2 text-xs"
                >
                  <div className="truncate">
                    <span className="font-medium text-white">{data.title || draft.id}</span>
                    <span className="ml-2 text-neutral-500">({draft.id})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteDraft(draft.id)}
                    aria-label={`Delete ${draft.id}`}
                    className="text-neutral-500 transition hover:text-rose-400"
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
