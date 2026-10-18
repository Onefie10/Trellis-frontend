import { LicenseAuditResult } from "../utils/licenseScanner";

interface LicenseComplianceCardProps {
  audit: LicenseAuditResult;
}

const statusStyles: Record<LicenseAuditResult["status"], string> = {
  Passed: "border-green-200 bg-green-50 text-green-800",
  Warning: "border-amber-200 bg-amber-50 text-amber-900",
  Incompatible: "border-red-200 bg-red-50 text-red-900",
  "Not scanned": "border-slate-200 bg-slate-50 text-slate-700",
};

export function LicenseComplianceCard({ audit }: LicenseComplianceCardProps) {
  return (
    <section className="rounded border border-slate-200 bg-white p-4" aria-label="License compliance breakdown">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium text-slate-900">License compliance</h3>
          <p className="text-sm text-slate-600">
            {audit.total === 0 ? "No dependency license metadata found." : `${audit.total} dependencies audited`}
          </p>
        </div>
        <span className={`rounded border px-2 py-1 text-xs font-semibold ${statusStyles[audit.status]}`}>
          {audit.status}
        </span>
      </div>

      {audit.total > 0 && (
        <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <div><dt className="text-slate-500">Compatible</dt><dd className="font-semibold">{audit.passed}</dd></div>
          <div><dt className="text-slate-500">Review</dt><dd className="font-semibold">{audit.warnings}</dd></div>
          <div><dt className="text-slate-500">Incompatible</dt><dd className="font-semibold">{audit.incompatible}</dd></div>
        </dl>
      )}

      {audit.findings.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
          {audit.findings.map((finding) => (
            <li key={`${finding.dependency}-${finding.expression ?? "missing"}`} className="py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-medium text-slate-900">{finding.dependency}</span>
                <span className="text-xs text-slate-600">{finding.expression ?? "License not provided"} · {finding.status}</span>
              </div>
              <p className="mt-1 text-slate-600">{finding.message}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}