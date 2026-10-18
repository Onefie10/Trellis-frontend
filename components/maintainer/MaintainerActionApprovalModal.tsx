'use client';

import React, { useState } from 'react';
import {
  type HighImpactMaintainerAction,
  type MaintainerIntentPayload,
  type SignedIntentReceipt,
  type MaintainerActor,
  HIGH_IMPACT_MAINTAINER_ACTIONS,
} from '@/lib/maintainer-approvals/types';
import { MaintainerApprovalService, determineImpactLevel } from '@/lib/maintainer-approvals/service';
import useFocusTrap from '@/components/useFocusTrap';

export interface MaintainerActionApprovalModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultAction?: HighImpactMaintainerAction;
  defaultTarget?: string;
  defaultParams?: Record<string, unknown>;
  maintainer: MaintainerActor;
  service?: MaintainerApprovalService;
  onApproved?: (receipt: SignedIntentReceipt) => void;
  isOffline?: boolean;
}

export function MaintainerActionApprovalModal({
  isOpen,
  onClose,
  defaultAction = 'emergency_pause',
  defaultTarget = 'treasury-contract-v1',
  defaultParams = { reason: 'Scheduled security review' },
  maintainer,
  service = new MaintainerApprovalService(),
  onApproved,
  isOffline = false,
}: MaintainerActionApprovalModalProps) {
  const [action, setAction] = useState<HighImpactMaintainerAction>(defaultAction);
  const [environment, setEnvironment] = useState<'development' | 'staging' | 'production'>('production');
  const [targetResource, setTargetResource] = useState(defaultTarget);
  const [justification, setJustification] = useState('');
  const [rawParams, setRawParams] = useState(JSON.stringify(defaultParams, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SignedIntentReceipt | null>(null);
  const [isSigning, setIsSigning] = useState(false);

  const trapRef = useFocusTrap<HTMLDivElement>({
    active: isOpen,
    onEscape: onClose,
  });

  if (!isOpen) return null;

  const impactLevel = determineImpactLevel(action);

  const handleSignAndSubmit = async () => {
    setError(null);
    setIsSigning(true);

    try {
      let parsedParams: Record<string, unknown> = {};
      try {
        parsedParams = JSON.parse(rawParams);
      } catch {
        throw new Error('Invalid JSON parameters format');
      }

      if (justification.trim().length < 10) {
        throw new Error('Justification must be at least 10 characters detailing why this high-impact action is necessary.');
      }

      const intentPayload: MaintainerIntentPayload = service.createIntentPayload({
        action,
        environment,
        targetResource,
        parameters: parsedParams,
        justification,
      });

      // Generate or use maintainer keypair for Ed25519 signature
      const { publicKeyHex, privateKeyHex } = MaintainerApprovalService.generateEd25519Keypair();
      const actor: MaintainerActor = {
        ...maintainer,
        publicKey: maintainer.publicKey || publicKeyHex,
      };

      const signedReceipt = service.approveAndSignIntent({
        payload: intentPayload,
        maintainer: actor,
        signerPrivateKey: privateKeyHex,
        isOffline,
      });

      setReceipt(signedReceipt);
      onApproved?.(signedReceipt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSigning(false);
    }
  };

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto"
    >
      <div className="relative w-full max-w-xl rounded-2xl border border-zinc-700 bg-zinc-900 p-6 text-zinc-100 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div>
            <h2 id="approval-modal-title" className="text-lg font-semibold text-white">
              Maintainer Action Intent Approval
            </h2>
            <p className="text-xs text-zinc-400">
              High-impact action verification and signed intent receipt generator
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {receipt ? (
          <div className="space-y-4 py-4" data-testid="signed-receipt-container">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4">
              <div className="flex items-center gap-2 text-emerald-400 font-medium">
                <span>✓ Intent Signed & Receipt Minted</span>
                {receipt.status === 'queued_offline' && (
                  <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">
                    Queued Offline
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-zinc-300">
                Receipt ID: <code className="font-mono text-zinc-100">{receipt.receiptId}</code>
              </p>
              <p className="text-xs text-zinc-300">
                Fingerprint: <code className="font-mono text-zinc-100">{receipt.intentFingerprint}</code>
              </p>
              <p className="text-xs text-zinc-300">
                Signer: <code className="font-mono text-zinc-100">{receipt.maintainer.publicKey}</code>
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-zinc-300">Canonical Signed Intent JSON:</label>
              <pre className="max-h-40 overflow-y-auto rounded-lg bg-zinc-950 p-3 text-xs font-mono text-zinc-300 border border-zinc-800">
                {receipt.canonicalIntentJson}
              </pre>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
              >
                Close & Review Receipt
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            {error && (
              <div
                role="alert"
                className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300"
              >
                {error}
              </div>
            )}

            {isOffline && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-300">
                ⚠️ Client is offline. This intent will be signed, verified locally, and queued for synchronization upon reconnect.
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="action-select" className="block text-xs font-medium text-zinc-300 mb-1">
                  High-Impact Action
                </label>
                <select
                  id="action-select"
                  value={action}
                  onChange={(e) => setAction(e.target.value as HighImpactMaintainerAction)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                >
                  {HIGH_IMPACT_MAINTAINER_ACTIONS.map((act) => (
                    <option key={act} value={act}>
                      {act}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="environment-select" className="block text-xs font-medium text-zinc-300 mb-1">
                  Environment
                </label>
                <select
                  id="environment-select"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value as 'development' | 'staging' | 'production')}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                >
                  <option value="development">development</option>
                  <option value="staging">staging</option>
                  <option value="production">production</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="target-resource" className="block text-xs font-medium text-zinc-300 mb-1">
                Target Resource Identifier
              </label>
              <input
                id="target-resource"
                type="text"
                value={targetResource}
                onChange={(e) => setTargetResource(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                placeholder="e.g. contract-pause-controller-prod"
              />
            </div>

            <div>
              <label htmlFor="parameters-json" className="block text-xs font-medium text-zinc-300 mb-1">
                Action Parameters (JSON)
              </label>
              <textarea
                id="parameters-json"
                rows={3}
                value={rawParams}
                onChange={(e) => setRawParams(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="justification-input" className="block text-xs font-medium text-zinc-300 mb-1">
                Maintainer Justification (Audit requirement, min 10 chars)
              </label>
              <input
                id="justification-input"
                type="text"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Operational justification for audit logs"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-between rounded-xl bg-zinc-950/60 p-3 border border-zinc-800 text-xs">
              <div>
                <span className="text-zinc-400">Impact Classification: </span>
                <span
                  className={`font-semibold ${
                    impactLevel === 'tier_3_critical'
                      ? 'text-rose-400'
                      : impactLevel === 'tier_2_sensitive'
                      ? 'text-amber-400'
                      : 'text-blue-400'
                  }`}
                >
                  {impactLevel}
                </span>
              </div>
              <div className="text-zinc-400">
                Maintainer: <span className="font-mono text-zinc-200">{maintainer.id}</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-zinc-800">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSignAndSubmit}
                disabled={isSigning}
                className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-lg hover:bg-emerald-500 disabled:opacity-50"
              >
                {isSigning ? 'Signing Intent…' : 'Sign Intent & Mint Receipt'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
