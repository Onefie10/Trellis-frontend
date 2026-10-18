"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AgentExecutionAttestation, ZkVerificationResult } from "../zk/types";
import { failureNotice, verifyAttestation, ZkVerificationCache } from "../zk/attestation";

/**
 * Shared verification cache for the explorer.
 *
 * Module-level on purpose: a proof that has been verified once should not be
 * re-verified when the user filters the timeline, but the cache is bounded so a
 * long session cannot grow without limit.
 */
export const sharedVerificationCache = new ZkVerificationCache(100);

const STATUS_STYLES: Record<ZkVerificationResult["status"], string> = {
  verified: "text-emerald-300 bg-emerald-400/10 border-emerald-400/30",
  invalid: "text-rose-300 bg-rose-400/10 border-rose-400/30",
  unverifiable: "text-amber-300 bg-amber-400/10 border-amber-400/30",
};

const STATUS_ICON: Record<ZkVerificationResult["status"], string> = {
  verified: "🔐",
  invalid: "⛔",
  unverifiable: "🕓",
};

const STATUS_LABEL: Record<ZkVerificationResult["status"], string> = {
  verified: "ZK verified",
  invalid: "ZK invalid",
  unverifiable: "ZK not confirmed",
};

export interface ZkVerificationBadgeProps {
  attestation: AgentExecutionAttestation;
  /** Called with the latest result so a parent can drive the inspector. */
  onVerified?: (result: ZkVerificationResult) => void;
  /** Start verifying as soon as the badge mounts (default: `true`). */
  autoVerify?: boolean;
  className?: string;
}

/**
 * Cryptographic verification badge for a single attestation.
 *
 * Renders three visually distinct states and never presents `unverifiable` as a
 * success — an attestation whose pairing equation was not evaluated is shown in
 * amber with an explicit "not confirmed" label.
 *
 * The `onVerified` callback is held in a ref so an inline arrow from the parent
 * cannot retrigger the verification effect on every render.
 */
export default function ZkVerificationBadge({
  attestation,
  onVerified,
  autoVerify = true,
  className = "",
}: ZkVerificationBadgeProps) {
  const [result, setResult] = useState<ZkVerificationResult | null>(null);
  const [busy, setBusy] = useState(false);

  const onVerifiedRef = useRef(onVerified);
  useEffect(() => {
    onVerifiedRef.current = onVerified;
  }, [onVerified]);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const next = await verifyAttestation(attestation, { cache: sharedVerificationCache });
      setResult(next);
      onVerifiedRef.current?.(next);
    } finally {
      setBusy(false);
    }
  }, [attestation]);

  useEffect(() => {
    if (!autoVerify) return;
    let cancelled = false;
    setBusy(true);
    verifyAttestation(attestation, { cache: sharedVerificationCache })
      .then((next) => {
        if (cancelled) return;
        setResult(next);
        onVerifiedRef.current?.(next);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attestation, autoVerify]);

  const status = result?.status;
  const tone = status ? STATUS_STYLES[status] : "text-gray-400 bg-gray-400/10 border-gray-400/20";
  const icon = status ? STATUS_ICON[status] : "🧮";
  const label = busy && !result ? "Verifying ZK proof…" : status ? STATUS_LABEL[status] : "ZK proof";

  return (
    <div
      className={`inline-flex flex-wrap items-center gap-2 ${className}`}
      data-testid="zk-verification-badge"
      data-zk-status={status ?? "pending"}
      data-circuit-id={attestation.circuitId}
    >
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tone}`}
        aria-live="polite"
      >
        <span aria-hidden="true">{icon}</span>
        {label}
      </span>

      {attestation.commitment && (
        <span className="text-[10px] font-mono text-gray-500">
          commitment {attestation.commitment.slice(0, 12)}…
        </span>
      )}

      {result && result.status !== "verified" && (
        <span
          role="alert"
          className={`text-[10px] ${result.status === "invalid" ? "text-rose-400" : "text-amber-400"}`}
          title={result.message}
        >
          {failureNotice(result)}
        </span>
      )}

      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded-md border border-trellis-vine/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-trellis-vine hover:border-trellis-vine/60 disabled:opacity-50"
      >
        {busy ? "Checking…" : "Re-verify"}
      </button>
    </div>
  );
}
