/**
 * PII / secret detection patterns for the activity timeline.
 *
 * Every pattern is stored as a **source string plus flags** rather than as a
 * shared `RegExp` instance. Global regexes are stateful (`lastIndex` survives
 * between calls), so reusing one across `replace`/`matchAll`/`test` is a
 * classic source of "redacts every other occurrence" bugs. {@link compilePattern}
 * hands out a fresh `RegExp` per call instead.
 */

export type PiiSeverity = "critical" | "high" | "medium";

export interface PiiPattern {
  /** Stable identifier; also used to build the `[REDACTED:<LABEL>]` token. */
  id: string;
  /** Uppercase badge label rendered in the UI and in exports. */
  label: string;
  description: string;
  severity: PiiSeverity;
  /** Regex source, always written without the `g` flag. */
  source: string;
  flags: string;
  /**
   * Optional replacement template. Uses `$1`/`$2` to *keep* a safe prefix (for
   * example the header name) while redacting the value. Defaults to the
   * `[REDACTED:<label>]` token built by the redactor.
   */
  replacement?: string;
}

/**
 * Ordered most-specific → least-specific.
 *
 * Order matters: a PEM block must be matched before the 64-hex key rule, a Stellar
 * `S…` secret before the `G…`/`C…` rules, and every credential rule before the
 * generic long-base64 catch-all.
 */
export const PII_PATTERNS: PiiPattern[] = [
  {
    id: "private-key-pem",
    label: "PRIVATE_KEY_PEM",
    description: "PEM-encoded private key block",
    severity: "critical",
    source: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    flags: "g",
  },
  {
    id: "db-connection",
    label: "DB_CONNECTION",
    description: "Database / broker connection string (usually embeds credentials)",
    severity: "critical",
    source: "\\b(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis(?:s)?|amqp(?:s)?)://[^\\s\"'`]+",
    flags: "gi",
  },
  {
    id: "jwt",
    label: "JWT",
    description: "JSON Web Token",
    severity: "critical",
    source: "\\beyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}\\b",
    flags: "g",
  },
  {
    id: "bearer-token",
    label: "BEARER_TOKEN",
    description: "`Bearer` authorization credential",
    severity: "critical",
    source: "\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}",
    flags: "g",
  },
  {
    id: "basic-auth",
    label: "BASIC_AUTH",
    description: "`Basic` authorization credential",
    severity: "critical",
    source: "\\bBasic\\s+[A-Za-z0-9+/=]{8,}",
    flags: "g",
  },
  {
    id: "auth-header",
    label: "AUTH_HEADER",
    description: "Authorization / API-key header value",
    severity: "critical",
    source:
      "\\b(authorization|auth[-_]?header|x[-_]api[-_]key|api[-_]?key)\\b\\s*[:=]\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s,;}{]+)",
    flags: "gi",
    replacement: "$1: [REDACTED:AUTH_HEADER]",
  },
  {
    id: "stellar-secret-key",
    label: "STELLAR_SECRET_KEY",
    description: "Stellar secret key (`S…`, 56 chars)",
    severity: "critical",
    source: "\\bS[A-Z2-7]{55}\\b",
    flags: "g",
  },
  {
    id: "stellar-public-key",
    label: "STELLAR_PUBLIC_KEY",
    description: "Stellar account address (`G…`, 56 chars)",
    severity: "high",
    source: "\\bG[A-Z2-7]{55}\\b",
    flags: "g",
  },
  {
    id: "stellar-contract-id",
    label: "STELLAR_CONTRACT_ID",
    description: "Soroban contract id (`C…`, 56 chars)",
    severity: "medium",
    source: "\\bC[A-Z2-7]{55}\\b",
    flags: "g",
  },
  {
    id: "aws-access-key",
    label: "AWS_ACCESS_KEY",
    description: "AWS access key id",
    severity: "critical",
    source: "\\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\\b",
    flags: "g",
  },
  {
    id: "github-token",
    label: "GITHUB_TOKEN",
    description: "GitHub personal access / app token",
    severity: "critical",
    source: "\\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\\b",
    flags: "g",
  },
  {
    id: "slack-token",
    label: "SLACK_TOKEN",
    description: "Slack API token",
    severity: "critical",
    source: "\\bxox[abprs]-[A-Za-z0-9-]{10,}\\b",
    flags: "g",
  },
  {
    id: "stripe-key",
    label: "STRIPE_KEY",
    description: "Stripe secret / restricted key",
    severity: "critical",
    source: "\\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\\b",
    flags: "g",
  },
  {
    id: "openai-key",
    label: "OPENAI_KEY",
    description: "OpenAI-style `sk-` API key",
    severity: "critical",
    source: "\\bsk-[A-Za-z0-9_-]{20,}\\b",
    flags: "g",
  },
  {
    id: "private-key-hex",
    label: "PRIVATE_KEY_HEX",
    description: "Raw 32-byte hex key material",
    severity: "critical",
    source: "\\b(?:0x)?[0-9a-fA-F]{64}\\b",
    flags: "g",
  },
  {
    id: "secret-assignment",
    label: "SECRET",
    description: "Secret-looking `key: value` / `key=value` assignment",
    severity: "high",
    source:
      "\\b(pass(?:word|wd|phrase)?|client[-_]?secret|secret[-_]?key|secret|token|private[-_]?key|mnemonic|seed[-_]?phrase|signature|session[-_]?id)\\b\\s*[:=]\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s,;}{]+)",
    flags: "gi",
    replacement: "$1: [REDACTED:SECRET]",
  },
  {
    id: "ipv4",
    label: "IPV4",
    description: "IPv4 address",
    severity: "high",
    source: "\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d?\\d)\\b",
    flags: "g",
  },
  {
    // At least three colons (or a `::` compression) so clock times such as
    // `12:34:56` are never mistaken for an address.
    id: "ipv6",
    label: "IPV6",
    description: "IPv6 address",
    severity: "high",
    source:
      "\\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\\b|\\b(?:[0-9a-fA-F]{1,4}:)+:(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{0,4}\\b|::[0-9a-fA-F]{1,4}\\b",
    flags: "g",
  },
  {
    id: "email",
    label: "EMAIL",
    description: "Email address",
    severity: "high",
    source: "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}",
    flags: "gi",
  },
  {
    id: "ssn",
    label: "SSN",
    description: "US social security number",
    severity: "critical",
    source: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    flags: "g",
  },
  {
    id: "credit-card",
    label: "CREDIT_CARD",
    description: "Payment card number",
    severity: "critical",
    source:
      "\\b(?:4\\d{3}|5[1-5]\\d{2}|3[47]\\d{2}|6(?:011|5\\d{2})|3(?:0[0-5]|[68]\\d)\\d)[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}\\b",
    flags: "g",
  },
  {
    id: "iban",
    label: "IBAN",
    description: "International bank account number",
    severity: "high",
    source: "\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b",
    flags: "g",
  },
  {
    id: "phone",
    label: "PHONE",
    description: "Phone number",
    severity: "medium",
    source: "(?:\\+[1-9]\\d{7,14}\\b|\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}\\b)",
    flags: "g",
  },
  {
    id: "base64-blob",
    label: "BASE64_BLOB",
    description: "Long base64-encoded blob (may embed key material)",
    severity: "medium",
    source: "\\b[A-Za-z0-9+/]{40,}={0,2}\\b",
    flags: "g",
  },
];

/** Build a fresh `RegExp` — never share `lastIndex` state across calls. */
export function compilePattern(pattern: PiiPattern): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

/** Canonical label for a `[REDACTED:<LABEL>]` token. */
export function tokenFor(label: string): string {
  return `[REDACTED:${label}]`;
}

/** Matches any redaction token produced by this module. */
export const REDACTION_TOKEN_RE = /\[REDACTED:[A-Z0-9_]+\]/g;

/** `true` when the string still contains a redaction token. */
export function containsRedactionToken(value: string): boolean {
  return new RegExp(REDACTION_TOKEN_RE.source).test(value);
}

/**
 * Normalise an object key so `apiKey`, `api_key` and `API-KEY` all collapse to
 * the same canonical form before lookup.
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Object keys whose **entire value** is dropped regardless of content — a raw IP
 * in `clientIp` is redacted even if it somehow fails the address regex.
 */
export const SENSITIVE_KEY_NAMES: ReadonlyMap<string, string> = new Map([
  ["email", "EMAIL"],
  ["emailaddress", "EMAIL"],
  ["phone", "PHONE"],
  ["phonenumber", "PHONE"],
  ["ssn", "SSN"],
  ["password", "PASSWORD"],
  ["passwd", "PASSWORD"],
  ["passphrase", "PASSWORD"],
  ["secret", "SECRET"],
  ["clientsecret", "SECRET"],
  ["token", "TOKEN"],
  ["accesstoken", "TOKEN"],
  ["refreshtoken", "TOKEN"],
  ["idtoken", "TOKEN"],
  ["sessionid", "SESSION_ID"],
  ["sessiontoken", "SESSION_ID"],
  ["apikey", "API_KEY"],
  ["authorization", "AUTHORIZATION"],
  ["authheader", "AUTHORIZATION"],
  ["cookie", "COOKIE"],
  ["setcookie", "COOKIE"],
  ["privatekey", "PRIVATE_KEY"],
  ["secretkey", "SECRET_KEY"],
  ["seedphrase", "SEED_PHRASE"],
  ["mnemonic", "MNEMONIC"],
  ["ipaddress", "IP_ADDRESS"],
  ["clientip", "IP_ADDRESS"],
  ["remoteip", "IP_ADDRESS"],
  ["xforwardedfor", "IP_ADDRESS"],
  ["useragent", "USER_AGENT"],
  ["walletaddress", "WALLET_ADDRESS"],
  ["accountaddress", "WALLET_ADDRESS"],
  ["stack", "STACK_TRACE"],
  ["stacktrace", "STACK_TRACE"],
]);

/** Resolve the canonical label for an object key, or `null` if it is safe. */
export function sensitiveKeyLabel(key: string): string | null {
  return SENSITIVE_KEY_NAMES.get(normalizeKey(key)) ?? null;
}
