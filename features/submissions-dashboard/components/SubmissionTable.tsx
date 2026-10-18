import { Submission } from "../types";
import { StatusBadge } from "./StatusBadge";
import { LicenseComplianceCard } from "./LicenseComplianceCard";

interface SubmissionTableProps {
  submissions: Submission[];
}

export function SubmissionTable({ submissions }: SubmissionTableProps) {
  if (submissions.length === 0) {
    return <p role="status" aria-live="polite">No submissions available.</p>;
  }

  return (
    <div className="overflow-x-auto rounded border border-slate-200">
      <table aria-label="Submissions" className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th scope="col" className="px-3 py-2">ID</th>
            <th scope="col" className="px-3 py-2">Tx Hash</th>
            <th scope="col" className="px-3 py-2">Status</th>
            <th scope="col" className="px-3 py-2">Timestamp</th>
            <th scope="col" className="px-3 py-2">Security Score</th>
            <th scope="col" className="px-3 py-2">License Audit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {submissions.map((submission) => (
            <tr key={submission.id}>
              <td className="px-3 py-2 align-top truncate max-w-xs">{submission.id}</td>
              <td className="px-3 py-2 align-top truncate max-w-xs">{submission.txHash}</td>
              <td className="px-3 py-2 align-top">
                <StatusBadge status={submission.status} />
              </td>
              <td className="px-3 py-2 align-top">{String(submission.timestamp)}</td>
              <td className="px-3 py-2 align-top">
                {submission.securityScan ? (
                  <div className="flex flex-col gap-2">
                    <span
                      className={`inline-block px-2 py-1 text-xs font-semibold rounded ${
                        submission.securityScan.score === "Passed"
                          ? "bg-green-100 text-green-800"
                          : submission.securityScan.score === "Warning"
                          ? "bg-yellow-100 text-yellow-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      {submission.securityScan.score}
                    </span>
                    {submission.securityScan.flags.length > 0 && (
                      <div className="text-xs text-slate-600 mt-1">
                        {submission.securityScan.flags.map((flag, idx) => (
                          <div key={idx} className="mb-2 bg-slate-50 p-2 rounded border border-slate-200">
                            <strong>{flag.type}:</strong> {flag.message}
                            <div className="mt-1 text-blue-700">
                              <em>Remediation:</em> {flag.remediation}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-slate-400 italic">Not scanned</span>
                )}
              </td>
              <td className="px-3 py-2 align-top">
                <details>
                  <summary className="cursor-pointer font-medium text-blue-700">
                    {submission.licenseAudit?.status ?? "Not scanned"}
                  </summary>
                  {submission.licenseAudit && (
                    <div className="mt-2 w-72 max-w-[80vw]">
                      <LicenseComplianceCard audit={submission.licenseAudit} />
                    </div>
                  )}
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
