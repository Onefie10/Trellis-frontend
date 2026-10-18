"use client";

import React from "react";
import type { AgentExecutionAttestation, ZkVerificationResult } from "../zk/types";
import { failureNotice, passedRatio } from "../zk/attestation";
import { shortSignal, signalToHex } from "../zk/verifier";

export interface ZkProofInspectorProps {
  attestation: AgentExecutionAttestation;
  result: ZkVerificationResult | null;
  onClose: () => void;
}

const CHECK_TONE = {
  passed: "text-emerald-300 border-emerald-400/30 bg-emerald-400/5",
  failed: "text-rose-300 border-rose-400/30 bg-rose-400/5",
} as const;

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-white/5 last:border-b-0">
      <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold shrink-0">
        {label}
      </span>
      <span className={`text-xs text-gray-200 text-right break-all ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * Detail inspector for a ZK attestation.
 *
 * Surfaces the circuit, every stage of the verification pipeline, the raw public
 * signals (as decimal and as 32-byte hex) and the proof points, so an auditor can
 * see exactly which check failed and on which value.
 */
export default function ZkProofInspector({ attestation, result, onClose }: ZkProofInspectorProps) {
  const ratio = result ? passedRatio(result) : 0;
  const badgeTone = result
    ? result.status === "verified"
      ? "text-emerald-300 border-emerald-400/40 bg-emerald-400/10"
      : result.status === "invalid"
        ? "text-rose-300 border-rose-400/40 bg-rose-400/10"
        : "text-amber-300 border-amber-400/40 bg-amber-400/10"
    : "text-gray-300 border-white/10 bg-white/5";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="ZK proof inspector"
      data-testid="zk-proof-inspector"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl rounded-xl border border-trellis-vine/25 nebula-bg p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-white">ZK proof inspector</h2>
            <p className="text-xs text-gray-400 font-mono mt-1">
              circuit {attestation.circuitId}
              {attestation.version ? ` · schema v${attestation.version}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/10 px-3 py-1 text-xs font-semibold text-gray-300 hover:border-white/30"
          >
            Close
          </button>
        </div>

        <div className={`rounded-lg border px-4 py-3 ${badgeTone}`}>
          <p className="text-sm font-semibold" data-testid="zk-inspector-status">
            {result ? result.status.toUpperCase() : "PENDING"}
          </p>
          <p className="text-xs mt-1 opacity-90">
            {result ? failureNotice(result) : "Verification has not run yet."}
          </p>
          <div className="mt-3 h-1.5 w-full rounded-full bg-black/40 overflow-hidden">
            <div
              className="h-full rounded-full bg-current transition-all"
              style={{ width: `${ratio}%` }}
              aria-hidden="true"
            />
          </div>
          <p className="text-[10px] uppercase tracking-widest mt-1.5 opacity-80">
            {ratio}% of checks passed
            {result ? ` · pairing evaluated: ${result.pairingEvaluated ? "yes" : "no"}` : ""}
          </p>
        </div>

        <section>
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">
            Verification pipeline
          </h3>
          <ul className="space-y-1.5">
            {(result?.checks ?? []).map((entry) => (
              <li
                key={entry.id}
                className={`flex items-start gap-2 rounded-md border px-3 py-2 ${
                  entry.passed ? CHECK_TONE.passed : CHECK_TONE.failed
                }`}
              >
                <span aria-hidden="true">{entry.passed ? "✓" : "✕"}</span>
                <div>
                  <p className="text-xs font-semibold">{entry.label}</p>
                  <p className="text-[11px] opacity-80 break-all">{entry.detail}</p>
                </div>
              </li>
            ))}
            {!result && (
              <li className="text-xs text-gray-500 italic">No verification result yet.</li>
            )}
          </ul>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">
              Attestation
            </h3>
            <Row label="Circuit" value={attestation.circuitId} mono />
            <Row label="Agent" value={attestation.agentId || "—"} mono />
            <Row label="Commitment" value={attestation.commitment ?? "—"} mono />
            <Row label="Public inputs" value={attestation.publicSignals.length} />
            <Row label="Curve" value={attestation.proof.curve} mono />
            <Row
              label="Verified at"
              value={result ? new Date(result.verifiedAt).toLocaleString() : "—"}
            />
          </div>

          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">
              Proof points
            </h3>
            <Row
              label="pi_a"
              mono
              value={`(${shortSignal(String(attestation.proof.pi_a[0]))}, ${shortSignal(String(attestation.proof.pi_a[1]))})`}
            />
            <Row
              label="pi_b.x"
              mono
              value={attestation.proof.pi_b[0].map((value) => shortSignal(String(value))).join(" · ")}
            />
            <Row
              label="pi_b.y"
              mono
              value={attestation.proof.pi_b[1].map((value) => shortSignal(String(value))).join(" · ")}
            />
            <Row
              label="pi_c"
              mono
              value={`(${shortSignal(String(attestation.proof.pi_c[0]))}, ${shortSignal(String(attestation.proof.pi_c[1]))})`}
            />
            <Row label="IC points" value={attestation.verificationKey.IC.length} />
          </div>
        </section>

        <section>
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">
            Public signals (decimal / 32-byte hex)
          </h3>
          <div className="space-y-1.5">
            {attestation.publicSignals.map((signal, index) => (
              <div
                key={`${index}-${signal}`}
                className="rounded-md border border-white/5 bg-black/20 px-3 py-2 font-mono text-[11px]"
              >
                <p className="text-gray-300 break-all">
                  <span className="text-gray-500 mr-2">#{index}</span>
                  {shortSignal(signal, 24, 10)}
                </p>
                <p className="text-gray-500 break-all mt-0.5">{signalToHex(signal)}</p>
              </div>
            ))}
            {attestation.publicSignals.length === 0 && (
              <p className="text-xs text-gray-500 italic">
                This circuit exposes no public inputs — the attestation proves execution without
                revealing anything.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
