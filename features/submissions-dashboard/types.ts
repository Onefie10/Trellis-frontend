import { SecurityScanResult } from "./utils/scanner";
import { LicenseAuditResult } from "./utils/licenseScanner";

export type SubmissionStatus = "pending" | "success" | "failed" | string;

export interface Submission {
  id: string;
  txHash: string;
  status: SubmissionStatus;
  timestamp: string | number;
  error?: string;
  content?: string;
  securityScan?: SecurityScanResult;
  licenseAudit?: LicenseAuditResult;
  [key: string]: unknown;
}
