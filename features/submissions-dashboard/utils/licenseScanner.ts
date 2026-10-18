export type LicenseAuditStatus = "Passed" | "Warning" | "Incompatible" | "Not scanned";

export interface DependencyLicense {
  name: string;
  license?: string;
}

export interface LicenseFinding {
  dependency: string;
  expression?: string;
  status: Exclude<LicenseAuditStatus, "Not scanned">;
  message: string;
}

export interface LicenseAuditResult {
  status: LicenseAuditStatus;
  total: number;
  passed: number;
  warnings: number;
  incompatible: number;
  findings: LicenseFinding[];
}

type LicenseClass = "permissive" | "weak-copyleft" | "strong-copyleft" | "unknown";
type LicenseExpression =
  | { type: "license"; identifier: string }
  | { type: "with"; license: LicenseExpression }
  | { type: "and" | "or"; left: LicenseExpression; right: LicenseExpression };

const LICENSE_CLASSES: Record<string, LicenseClass> = {
  "0BSD": "permissive",
  "Apache-2.0": "permissive",
  "BSD-2-Clause": "permissive",
  "BSD-3-Clause": "permissive",
  "BSL-1.0": "permissive",
  "CC0-1.0": "permissive",
  "ISC": "permissive",
  "MIT": "permissive",
  "Unlicense": "permissive",
  "Zlib": "permissive",
  "EPL-1.0": "weak-copyleft",
  "EPL-2.0": "weak-copyleft",
  "LGPL-2.0-only": "weak-copyleft",
  "LGPL-2.0": "weak-copyleft",
  "LGPL-2.0-or-later": "weak-copyleft",
  "LGPL-2.1-only": "weak-copyleft",
  "LGPL-2.1": "weak-copyleft",
  "LGPL-2.1-or-later": "weak-copyleft",
  "LGPL-3.0-only": "weak-copyleft",
  "LGPL-3.0": "weak-copyleft",
  "LGPL-3.0-or-later": "weak-copyleft",
  "MPL-2.0": "weak-copyleft",
  "AGPL-1.0-only": "strong-copyleft",
  "AGPL-1.0": "strong-copyleft",
  "AGPL-1.0-or-later": "strong-copyleft",
  "AGPL-3.0-only": "strong-copyleft",
  "AGPL-3.0": "strong-copyleft",
  "AGPL-3.0-or-later": "strong-copyleft",
  "GPL-1.0-only": "strong-copyleft",
  "GPL-1.0": "strong-copyleft",
  "GPL-1.0-or-later": "strong-copyleft",
  "GPL-2.0-only": "strong-copyleft",
  "GPL-2.0": "strong-copyleft",
  "GPL-2.0-or-later": "strong-copyleft",
  "GPL-3.0-only": "strong-copyleft",
  "GPL-3.0": "strong-copyleft",
  "GPL-3.0-or-later": "strong-copyleft",
};

function tokenize(expression: string): string[] | null {
  expression = expression.trim();
  const tokens: string[] = [];
  const tokenPattern = /\s*([()]|[A-Za-z0-9][A-Za-z0-9.+:-]*)/gy;
  let position = 0;

  while (position < expression.length) {
    tokenPattern.lastIndex = position;
    const match = tokenPattern.exec(expression);
    if (!match) return null;
    tokens.push(match[1]);
    position = tokenPattern.lastIndex;
  }

  return tokens;
}

export function parseSpdxExpression(expression: string): LicenseExpression | null {
  const tokens = tokenize(expression);
  if (!tokens?.length) return null;
  let position = 0;

  const parsePrimary = (): LicenseExpression | null => {
    let value: LicenseExpression | null;
    if (tokens[position] === "(") {
      position += 1;
      value = parseOr();
      if (!value || tokens[position] !== ")") return null;
      position += 1;
    } else {
      const identifier = tokens[position];
      if (!identifier || ["AND", "OR", "WITH", ")"].includes(identifier)) return null;
      position += 1;
      value = { type: "license", identifier };
    }

    if (tokens[position] === "WITH") {
      position += 1;
      const exception = tokens[position];
      if (!exception || ["AND", "OR", "WITH", "(", ")"].includes(exception)) return null;
      position += 1;
      value = { type: "with", license: value };
    }
    return value;
  };

  const parseAnd = (): LicenseExpression | null => {
    let left = parsePrimary();
    while (left && tokens[position] === "AND") {
      position += 1;
      const right = parsePrimary();
      if (!right) return null;
      left = { type: "and", left, right };
    }
    return left;
  };

  const parseOr = (): LicenseExpression | null => {
    let left = parseAnd();
    while (left && tokens[position] === "OR") {
      position += 1;
      const right = parseAnd();
      if (!right) return null;
      left = { type: "or", left, right };
    }
    return left;
  };

  const result = parseOr();
  return result && position === tokens.length ? result : null;
}

function classifyExpression(expression: LicenseExpression): LicenseClass {
  if (expression.type === "license") {
    const normalized = expression.identifier.replace(/\+$/, "-or-later");
    return LICENSE_CLASSES[normalized] ?? "unknown";
  }
  if (expression.type === "with") return classifyExpression(expression.license);

  const left = classifyExpression(expression.left);
  const right = classifyExpression(expression.right);
  if (expression.type === "or") {
    if (left === "permissive" || right === "permissive") return "permissive";
    if (left === "unknown" || right === "unknown") return "unknown";
  }

  const rank: Record<LicenseClass, number> = {
    permissive: 0,
    "weak-copyleft": 1,
    unknown: 2,
    "strong-copyleft": 3,
  };
  return rank[left] >= rank[right] ? left : right;
}

function evaluateLicense(expression: string): { status: LicenseFinding["status"]; message: string } {
  const parsed = parseSpdxExpression(expression);
  if (!parsed) {
    return { status: "Warning", message: "License metadata is not a valid SPDX expression." };
  }

  switch (classifyExpression(parsed)) {
    case "permissive":
      return { status: "Passed", message: "License is compatible with commercial marketplace distribution." };
    case "weak-copyleft":
      return { status: "Warning", message: "Copyleft obligations require maintainer review before distribution." };
    case "strong-copyleft":
      return { status: "Incompatible", message: "Strong copyleft is incompatible with commercial marketplace distribution." };
    default:
      return { status: "Warning", message: "License identifier is not covered by the policy; verify its terms." };
  }
}

export function scanDependencyLicenses(dependencies: DependencyLicense[]): LicenseAuditResult {
  if (dependencies.length === 0) {
    return { status: "Not scanned", total: 0, passed: 0, warnings: 0, incompatible: 0, findings: [] };
  }

  const findings = dependencies.map(({ name, license }) => {
    const expression = license?.trim();
    if (!expression) {
      return {
        dependency: name,
        status: "Warning" as const,
        message: "No license metadata provided; dependency compliance cannot be verified.",
      };
    }
    return { dependency: name, expression, ...evaluateLicense(expression) };
  });
  const incompatible = findings.filter((finding) => finding.status === "Incompatible").length;
  const warnings = findings.filter((finding) => finding.status === "Warning").length;
  const passed = findings.length - incompatible - warnings;

  return {
    status: incompatible > 0 ? "Incompatible" : warnings > 0 ? "Warning" : "Passed",
    total: findings.length,
    passed,
    warnings,
    incompatible,
    findings,
  };
}