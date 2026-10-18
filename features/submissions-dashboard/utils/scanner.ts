export type SecuritySeverity = "Passed" | "Warning" | "Critical";

export interface SecurityFlag {
  type: string;
  severity: SecuritySeverity;
  message: string;
  remediation: string;
}

export interface SecurityScanResult {
  score: SecuritySeverity;
  flags: SecurityFlag[];
}

export function scanSubmissionContent(content: string): SecurityScanResult {
  const flags: SecurityFlag[] = [];

  if (!content) {
    return { score: "Passed", flags };
  }

  // Exposed API keys
  // Catch sk_live_..., sk_test_..., AKIA..., and api_key="..."
  const apiKeyRegex = /sk_(live|test)_[0-9a-zA-Z]+|AKIA[0-9A-Z]{16}|(?:api_key|apikey|secret)["'\s:=]+[0-9a-zA-Z]{16,}/i;
  // Let's refine the regex to ignore certain false positives, e.g. a string literal "api_key" without a secret
  if (apiKeyRegex.test(content)) {
    flags.push({
      type: "Exposed API Key",
      severity: "Critical",
      message: "Hardcoded API key detected in the submission.",
      remediation: "Remove the hardcoded key and use secure environment variables or vault secrets instead."
    });
  }

  // Dangerous eval calls
  const evalRegex = /eval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"]|setInterval\s*\(\s*['"]/;
  if (evalRegex.test(content)) {
    flags.push({
      type: "Dangerous Eval",
      severity: "Critical",
      message: "Use of eval() or dynamic code execution detected.",
      remediation: "Refactor code to avoid dynamic execution. Use safer alternatives like JSON.parse() or direct function calls."
    });
  }

  // Malicious redirects
  const redirectRegex = /window\.location\s*=|window\.location\.href\s*=|window\.location\.assign|window\.location\.replace|<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i;
  if (redirectRegex.test(content)) {
    flags.push({
      type: "Malicious Redirect",
      severity: "Warning",
      message: "Client-side redirect detected.",
      remediation: "Ensure any redirects are validated against an allowlist and only point to trusted domains."
    });
  }

  let score: SecuritySeverity = "Passed";
  if (flags.some(f => f.severity === "Critical")) {
    score = "Critical";
  } else if (flags.some(f => f.severity === "Warning")) {
    score = "Warning";
  }

  return { score, flags };
}
