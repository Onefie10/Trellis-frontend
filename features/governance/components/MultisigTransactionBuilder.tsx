'use client';

import React, { useMemo, useState } from 'react';
import {
  aggregateSignatures,
  buildTreasurySpendEnvelope,
  exportPartialEnvelope,
  getSignatureProgress,
  importPartialEnvelope,
  signEnvelope,
  validateMultisigConfig,
  type SignatureProgress,
} from '@/lib/governance/multisig';

export interface MultisigTransactionBuilderProps {
  /** Unsigned (or partially signed) treasury transaction envelope XDR. */
  initialXdr?: string;
  networkPassphrase: string;
  signers: string[];
  threshold: number;
  treasuryAccount?: string;
  proposalId?: string;
  proposalTitle?: string;
  /** Called once the threshold is met, with the fully signed XDR. */
  onComplete?: (signedXdr: string) => void;
  /** Optional submit handler when threshold is met. */
  onSubmit?: (signedXdr: string) => Promise<void> | void;
  /** Optional close handler if shown in a dialog/modal. */
  onClose?: () => void;
}

export function MultisigTransactionBuilder({
  initialXdr = '',
  networkPassphrase,
  signers,
  threshold,
  treasuryAccount,
  proposalId,
  proposalTitle,
  onComplete,
  onSubmit,
  onClose,
}: MultisigTransactionBuilderProps) {
  const [envelope, setEnvelope] = useState(initialXdr);
  const [importInput, setImportInput] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [copiedXdr, setCopiedXdr] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Quick form state for building a treasury spend tx if none was passed
  const [spendDest, setSpendDest] = useState('');
  const [spendAmount, setSpendAmount] = useState('');
  const [spendMemo, setSpendMemo] = useState(proposalId ? `Execute ${proposalId}` : '');

  const configErrors = useMemo(
    () => validateMultisigConfig({ signers, threshold }),
    [signers, threshold],
  );

  const progress: SignatureProgress | null = useMemo(() => {
    if (!envelope || configErrors.length > 0) return null;
    try {
      return getSignatureProgress(envelope, networkPassphrase, { signers, threshold });
    } catch {
      return null;
    }
  }, [envelope, networkPassphrase, signers, threshold, configErrors]);

  function updateEnvelope(next: string) {
    setEnvelope(next);
    setError(null);
    setSuccessMsg(null);
    try {
      const p = getSignatureProgress(next, networkPassphrase, { signers, threshold });
      if (p.isComplete) {
        onComplete?.(next);
      }
    } catch {
      // Handled on user action
    }
  }

  function handleSignWithSecret() {
    if (!envelope || !secret) return;
    try {
      const signed = signEnvelope(envelope, networkPassphrase, secret.trim());
      updateEnvelope(signed);
      setSecret('');
      setSuccessMsg('Successfully applied signature to transaction envelope.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to sign transaction.');
    }
  }

  function handleMergeCoSigner() {
    if (!envelope || !importInput) return;
    try {
      const importedXdr = importPartialEnvelope(importInput);
      const merged = aggregateSignatures([envelope, importedXdr], networkPassphrase);
      updateEnvelope(merged);
      setImportInput('');
      setSuccessMsg('Successfully merged co-signer signature(s).');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to merge signatures.');
    }
  }

  function handleBuildSpendTx() {
    if (!treasuryAccount || !spendDest || !spendAmount) {
      setError('Please provide destination account and amount in XLM.');
      return;
    }
    try {
      const xdr = buildTreasurySpendEnvelope({
        networkPassphrase,
        treasuryAccount,
        destination: spendDest.trim(),
        amount: spendAmount.trim(),
        memo: spendMemo.trim() || undefined,
      });
      updateEnvelope(xdr);
      setSuccessMsg('Treasury spend transaction envelope generated.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to build treasury transaction.');
    }
  }

  const exportedPayload = useMemo(() => {
    if (!envelope || configErrors.length > 0) return null;
    try {
      return exportPartialEnvelope(envelope, networkPassphrase, { signers, threshold });
    } catch {
      return null;
    }
  }, [envelope, networkPassphrase, signers, threshold, configErrors]);

  const exportedJsonString = useMemo(() => {
    if (!exportedPayload) return '';
    return JSON.stringify(exportedPayload, null, 2);
  }, [exportedPayload]);

  function handleDownloadJson() {
    if (!exportedJsonString) return;
    const blob = new Blob([exportedJsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `treasury-multisig-${proposalId || 'tx'}-partial.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSuccessMsg('Exported partial transaction envelope JSON for off-chain review.');
  }

  async function handleCopyXdr() {
    if (!envelope) return;
    await navigator.clipboard.writeText(envelope);
    setCopiedXdr(true);
    setTimeout(() => setCopiedXdr(false), 2000);
  }

  async function handleCopyJson() {
    if (!exportedJsonString) return;
    await navigator.clipboard.writeText(exportedJsonString);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  }

  async function handleSubmit() {
    if (!progress?.isComplete || !onSubmit) return;
    try {
      setIsSubmitting(true);
      setError(null);
      await onSubmit(envelope);
      setSuccessMsg('Transaction successfully submitted to the Stellar network!');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit transaction.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (configErrors.length > 0) {
    return (
      <div role="alert" className="p-4 rounded-xl bg-red-950/40 border border-red-500/50 text-red-200 text-sm space-y-1">
        <h4 className="font-semibold text-red-300">Invalid Multi-Sig Configuration:</h4>
        {configErrors.map((e) => (
          <p key={e}>• {e}</p>
        ))}
      </div>
    );
  }

  const pct = progress ? Math.min(100, Math.round((progress.collected / progress.required) * 100)) : 0;

  return (
    <section
      aria-label="Multisig transaction builder"
      className="p-6 rounded-2xl bg-[#0e0e15] border border-trellis-vine/40 text-gray-200 space-y-6 shadow-xl"
    >
      <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
              Soroban DAO Treasury
            </span>
            <span className="text-xs text-gray-400">
              Threshold: {threshold}-of-{signers.length} Signers
            </span>
          </div>
          <h3 className="text-xl font-bold text-white">
            Multi-Signature Transaction Builder
          </h3>
          {proposalTitle && (
            <p className="text-xs text-gray-400 mt-1">
              Proposal: <span className="text-gray-200 font-medium">{proposalTitle}</span> ({proposalId})
            </p>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close multisig builder"
          >
            ✕
          </button>
        )}
      </div>

      {/* Optional generator if envelope is empty and treasury account provided */}
      {!envelope && treasuryAccount && (
        <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-3">
          <h4 className="text-sm font-semibold text-white">Initialize Treasury Transfer Envelope</h4>
          <p className="text-xs text-gray-400">
            Source account: <span className="font-mono text-gray-300">{treasuryAccount}</span>
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="multisig-dest" className="block text-xs text-gray-300 mb-1">Destination Account (G...)</label>
              <input
                id="multisig-dest"
                type="text"
                placeholder="G..."
                className="w-full rounded-lg bg-black/50 border border-gray-700 px-3 py-1.5 text-xs font-mono text-white focus:border-indigo-400 outline-none"
                value={spendDest}
                onChange={(e) => setSpendDest(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="multisig-amount" className="block text-xs text-gray-300 mb-1">Amount (XLM)</label>
              <input
                id="multisig-amount"
                type="number"
                placeholder="e.g. 5000"
                className="w-full rounded-lg bg-black/50 border border-gray-700 px-3 py-1.5 text-xs text-white focus:border-indigo-400 outline-none"
                value={spendAmount}
                onChange={(e) => setSpendAmount(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label htmlFor="multisig-memo" className="block text-xs text-gray-300 mb-1">Memo (Optional)</label>
            <input
              id="multisig-memo"
              type="text"
              placeholder="e.g. Dev grant disbursement"
              className="w-full rounded-lg bg-black/50 border border-gray-700 px-3 py-1.5 text-xs text-white focus:border-indigo-400 outline-none"
              value={spendMemo}
              onChange={(e) => setSpendMemo(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={handleBuildSpendTx}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors"
          >
            Create Base Treasury Envelope
          </button>
        </div>
      )}

      {/* Transaction Envelope (XDR) Input */}
      <div>
        <label htmlFor="multisig-envelope-xdr" className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
          Transaction Envelope XDR
        </label>
        <textarea
          id="multisig-envelope-xdr"
          aria-label="Transaction envelope XDR"
          className="w-full rounded-lg border border-gray-700 bg-black/60 p-3 font-mono text-xs text-gray-300 focus:border-indigo-500 outline-none transition-colors"
          rows={3}
          placeholder="Paste Stellar transaction envelope base64 XDR..."
          value={envelope}
          onChange={(e) => updateEnvelope(e.target.value)}
        />
      </div>

      {/* Signature Collection Progress */}
      {progress && (
        <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold text-white">Threshold Signatures Collected</h4>
              <p data-testid="signature-progress" className="text-xs text-gray-300 font-mono mt-0.5">
                {progress.collected}/{progress.required} required signatures gathered
                {progress.isComplete ? (
                  <span className="ml-2 font-semibold text-emerald-400">✓ Ready to execute</span>
                ) : (
                  <span className="ml-2 text-amber-300">
                    ({progress.required - progress.collected} more needed)
                  </span>
                )}
              </p>
            </div>
            <span
              className={`px-3 py-1 rounded-full text-xs font-semibold self-start sm:self-auto ${
                progress.isComplete
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
              }`}
            >
              {progress.isComplete ? 'Threshold Reached' : 'Pending Co-Signers'}
            </span>
          </div>

          {/* Progress bar */}
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.required}
            aria-valuenow={Math.min(progress.collected, progress.required)}
            aria-label="Signature collection progress"
            className="h-2.5 rounded-full bg-gray-800 overflow-hidden"
          >
            <div
              className={`h-full transition-all duration-300 motion-reduce:transition-none ${
                progress.isComplete ? 'bg-emerald-500' : 'bg-gradient-to-r from-amber-500 to-indigo-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* Signer roster checklist */}
          <div className="space-y-1.5 pt-2 border-t border-white/5">
            <h5 className="text-[11px] uppercase tracking-wider text-gray-400 font-semibold">
              Authorized Signers ({signers.length}):
            </h5>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs font-mono">
              {signers.map((s) => {
                const isSigned = progress.signedBy.includes(s);
                return (
                  <li
                    key={s}
                    className={`flex items-center gap-2 p-2 rounded-lg border ${
                      isSigned
                        ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
                        : 'bg-black/30 border-white/5 text-gray-400'
                    }`}
                  >
                    <span
                      aria-label={isSigned ? 'Signed' : 'Pending'}
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                        isSigned
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400'
                          : 'bg-gray-800 text-gray-500 border border-gray-700'
                      }`}
                    >
                      {isSigned ? '✓' : '○'}
                    </span>
                    <span className="truncate" title={s}>
                      {s.slice(0, 8)}…{s.slice(-8)}
                    </span>
                    <span className="ml-auto text-[10px] uppercase font-semibold">
                      {isSigned ? 'Signed' : 'Pending'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {progress.invalidCount > 0 && (
            <p className="text-xs text-amber-300 bg-amber-950/30 p-2 rounded-lg border border-amber-500/30">
              ⚠️ {progress.invalidCount} signature(s) on envelope did not match any authorized signer.
            </p>
          )}
        </div>
      )}

      {/* Sign with Local Key */}
      <div className="space-y-2 p-4 rounded-xl bg-white/5 border border-white/10">
        <h4 className="text-xs uppercase font-semibold text-gray-300">Sign with Authorized Key</h4>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="password"
            aria-label="Signer secret key"
            placeholder="Signer secret key S... (used locally in browser, never transmitted)"
            className="flex-1 rounded-lg bg-black/50 border border-gray-700 px-3 py-2 text-xs font-mono text-white focus:border-indigo-400 outline-none"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <button
            type="button"
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold text-xs transition-colors"
            disabled={!envelope || !secret}
            onClick={handleSignWithSecret}
          >
            Sign Envelope
          </button>
        </div>
      </div>

      {/* Merge co-signer signatures */}
      <div className="space-y-2 p-4 rounded-xl bg-white/5 border border-white/10">
        <h4 className="text-xs uppercase font-semibold text-gray-300">
          Merge Co-Signer Signature(s)
        </h4>
        <textarea
          aria-label="Co-signer envelope XDR"
          placeholder="Paste co-signer's partially signed envelope XDR or exported JSON payload..."
          className="w-full rounded-lg bg-black/50 border border-gray-700 p-2.5 font-mono text-xs text-gray-300 focus:border-indigo-400 outline-none"
          rows={2}
          value={importInput}
          onChange={(e) => setImportInput(e.target.value)}
        />
        <button
          type="button"
          className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white font-semibold text-xs transition-colors"
          disabled={!envelope || !importInput.trim()}
          onClick={handleMergeCoSigner}
        >
          Merge Signatures
        </button>
      </div>

      {/* Share / Export & Submit Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg border border-gray-700 bg-black/40 hover:bg-white/10 text-xs font-medium text-gray-300 transition-colors disabled:opacity-40"
            disabled={!envelope}
            onClick={handleCopyXdr}
          >
            {copiedXdr ? '✓ Copied XDR' : 'Copy XDR'}
          </button>
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg border border-gray-700 bg-black/40 hover:bg-white/10 text-xs font-medium text-gray-300 transition-colors disabled:opacity-40"
            disabled={!exportedJsonString}
            onClick={handleCopyJson}
          >
            {copiedJson ? '✓ Copied JSON' : 'Copy JSON'}
          </button>
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg border border-indigo-500/40 bg-indigo-950/30 hover:bg-indigo-900/50 text-xs font-medium text-indigo-300 transition-colors disabled:opacity-40"
            disabled={!exportedJsonString}
            onClick={handleDownloadJson}
          >
            Export Partial JSON
          </button>
        </div>

        {onSubmit && (
          <button
            type="button"
            disabled={!progress?.isComplete || isSubmitting}
            onClick={handleSubmit}
            className="px-5 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 text-white font-semibold text-xs shadow-lg transition-all"
          >
            {isSubmitting ? 'Submitting...' : 'Submit Transaction On-Chain'}
          </button>
        )}
      </div>

      {/* Alerts */}
      {error && (
        <div role="alert" aria-live="assertive" className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-200 text-xs">
          ✕ {error}
        </div>
      )}
      {successMsg && (
        <div role="status" aria-live="polite" className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-emerald-200 text-xs">
          ✓ {successMsg}
        </div>
      )}
    </section>
  );
}

export default MultisigTransactionBuilder;
