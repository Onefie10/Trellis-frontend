"use client";

import { useEffect, useState } from "react";
import { analyticsManager } from "@/lib/analytics";
import type { PrivacyAuditSnapshot } from "./privacy";

export default function PrivacyAuditPanel() {
  const [audit, setAudit] = useState<PrivacyAuditSnapshot | null>(null);

  useEffect(() => {
    setAudit(analyticsManager.getPrivacyAuditLog());
  }, []);

  const updateEpsilon = (epsilon: number) => {
    analyticsManager.setPrivacyEpsilon(epsilon);
    setAudit(analyticsManager.getPrivacyAuditLog());
  };

  return (
    <section
      aria-labelledby="analytics-privacy-title"
      className="rounded-xl border border-slate-700 bg-slate-900/70 p-5 text-slate-100"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="analytics-privacy-title" className="text-lg font-semibold">
            Privacy protection audit
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-300">
            Client reports use allowlisted aggregate counts with Laplace noise. Raw event IDs,
            timestamps, values, and dimensions are not included in transmitted reports.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span>ε per report</span>
          <select
            aria-label="Differential privacy epsilon per report"
            className="rounded border border-slate-600 bg-slate-800 px-2 py-1"
            onChange={(event) => updateEpsilon(Number(event.target.value))}
            value={audit?.epsilon ?? 0.5}
          >
            {[0.1, 0.25, 0.5, 1, 2].map((epsilon) => (
              <option key={epsilon} value={epsilon}>{epsilon}</option>
            ))}
          </select>
        </label>
      </div>

      {audit && (
        <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <p><span className="text-slate-400">Client reporting:</span> {audit.enabled ? "enabled" : "disabled"}</p>
          <p><span className="text-slate-400">Mechanism:</span> {audit.mechanism}</p>
          <p><span className="text-slate-400">Daily ε budget:</span> {audit.dailyBudget}</p>
          <p><span className="text-slate-400">Remaining today:</span> {audit.remaining.toFixed(2)}</p>
        </div>
      )}

      <div className="mt-4 border-t border-slate-700 pt-3">
        <h3 className="text-sm font-medium">Recent privacy releases</h3>
        {audit?.entries.length ? (
          <ul className="mt-2 space-y-1 text-xs text-slate-300">
            {[...audit.entries].reverse().slice(0, 5).map((entry, index) => (
              <li key={`${entry.timestamp}-${index}`}>
                {new Date(entry.timestamp).toLocaleTimeString()} — {entry.status.replace("_", " ")}
                {entry.status === "released" && ` (${entry.metricGroups} groups, ε=${entry.epsilon.toFixed(2)})`}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-slate-400">No reports released today.</p>
        )}
      </div>
    </section>
  );
}
