import {
  PII_PATTERNS,
  REDACTION_TOKEN_RE,
  compilePattern,
  containsRedactionToken,
  normalizeKey,
  sensitiveKeyLabel,
  tokenFor,
} from "../redaction/patterns";
import {
  describeFindings,
  highestSeverity,
  redactString,
  redactTimelineEvent,
  redactTimelineEvents,
  redactValue,
} from "../redaction/redactor";
import { eventSeverity, EVENT_SEVERITY, isEventSeverity } from "../severity";
import type { TimelineEvent } from "../types";

const STELLAR_SECRET = `S${"A".repeat(55)}`;
const STELLAR_PUBLIC = `G${"B".repeat(55)}`;
const STELLAR_CONTRACT = `C${"D".repeat(55)}`;
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk";
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "b3JkZXIgb2YgdGhlIHBobyBub29kbGU=",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "evt-1",
    userId: "user-1",
    type: "claim_settled",
    visibility: "private",
    timestamp: Date.parse("2026-09-27T05:00:00.000Z"),
    title: "Claim settled",
    description: "Your claim was settled.",
    ...overrides,
  };
}

describe("pattern registry", () => {
  it("gives every pattern a unique id and label", () => {
    const ids = PII_PATTERNS.map((pattern) => pattern.id);
    const labels = PII_PATTERNS.map((pattern) => pattern.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never ships a stateful `g` regex instance", () => {
    const pattern = PII_PATTERNS[0];
    const first = compilePattern(pattern);
    const second = compilePattern(pattern);
    expect(first).not.toBe(second);
    first.exec("-----BEGIN RSA PRIVATE KEY-----x-----END RSA PRIVATE KEY-----");
    // A shared instance would now carry a non-zero lastIndex and skip the next hit.
    expect(second.lastIndex).toBe(0);
  });

  it("builds `[REDACTED:<LABEL>]` tokens", () => {
    expect(tokenFor("IPV4")).toBe("[REDACTED:IPV4]");
    expect(new RegExp(REDACTION_TOKEN_RE.source).test(tokenFor("IPV4"))).toBe(true);
  });

  it("normalises key names before lookup", () => {
    expect(normalizeKey("API-Key")).toBe("apikey");
    expect(sensitiveKeyLabel("API-Key")).toBe("API_KEY");
    expect(sensitiveKeyLabel("clientIp")).toBe("IP_ADDRESS");
    expect(sensitiveKeyLabel("createdAt")).toBeNull();
  });

  it("detects an existing redaction token", () => {
    expect(containsRedactionToken("[REDACTED:EMAIL]")).toBe(true);
    expect(containsRedactionToken("nothing here")).toBe(false);
  });
});

describe("redactString — credential patterns", () => {
  it("redacts a JWT", () => {
    const { text, findings } = redactString(`jwt=${JWT}`);
    expect(text).toBe("jwt=[REDACTED:JWT]");
    expect(findings).toEqual([
      expect.objectContaining({ id: "jwt", label: "JWT", severity: "critical", count: 1 }),
    ]);
  });

  it("redacts a bearer credential", () => {
    const { text } = redactString("Bearer abcdefghijklmnop");
    expect(text).toBe("[REDACTED:BEARER_TOKEN]");
  });

  it("redacts an authorization header while keeping the header name", () => {
    const { text } = redactString('Authorization: "Bearer abc12345678"');
    expect(text).toBe("Authorization: [REDACTED:AUTH_HEADER]");
    expect(text).not.toContain("abc12345678");
  });

  it("redacts a PEM private key block", () => {
    const { text, findings } = redactString(`key material:\n${PEM}\ndone`);
    expect(text).toBe("key material:\n[REDACTED:PRIVATE_KEY_PEM]\ndone");
    expect(findings.map((finding) => finding.label)).toContain("PRIVATE_KEY_PEM");
  });

  it("redacts a Stellar secret key", () => {
    expect(redactString(`secret ${STELLAR_SECRET} here`).text).toBe(
      "secret [REDACTED:STELLAR_SECRET_KEY] here",
    );
  });

  it("redacts Stellar account addresses and Soroban contract ids", () => {
    expect(redactString(`from ${STELLAR_PUBLIC}`).text).toBe(
      "from [REDACTED:STELLAR_PUBLIC_KEY]",
    );
    expect(redactString(`call ${STELLAR_CONTRACT}`).text).toBe(
      "call [REDACTED:STELLAR_CONTRACT_ID]",
    );
  });

  it("redacts GitHub, AWS, Slack, Stripe and OpenAI keys", () => {
    expect(redactString(`token ghp_${"a".repeat(36)}`).text).toBe(
      "token [REDACTED:GITHUB_TOKEN]",
    );
    expect(redactString("AKIAIOSFODNN7EXAMPLE").text).toBe("[REDACTED:AWS_ACCESS_KEY]");
    expect(redactString(`xoxb-${"1".repeat(12)}`).text).toBe("[REDACTED:SLACK_TOKEN]");
    expect(redactString(`sk_live_${"a".repeat(16)}`).text).toBe("[REDACTED:STRIPE_KEY]");
  });

  it("redacts raw 32-byte hex key material", () => {
    const hex = "0123456789abcdef".repeat(4);
    expect(hex).toHaveLength(64);
    expect(redactString(hex).text).toBe("[REDACTED:PRIVATE_KEY_HEX]");
  });

  it("redacts a database connection string", () => {
    const { text } = redactString("dsn=postgres://user:pw@db.internal:5432/app");
    expect(text).toBe("dsn=[REDACTED:DB_CONNECTION]");
  });

  it("redacts secret-looking assignments but keeps the key name", () => {
    const { text, findings } = redactString("config: password=hunter2 & token=abc123");
    expect(text).toContain("password: [REDACTED:SECRET]");
    expect(text).toContain("token: [REDACTED:SECRET]");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc123");
    expect(findings).toEqual([
      expect.objectContaining({ id: "secret-assignment", count: 2 }),
    ]);
  });

  it("redacts a snake_case client_secret assignment", () => {
    const { text } = redactString("client_secret=supersecretvalue");
    expect(text).toBe("client_secret: [REDACTED:SECRET]");
  });
});

describe("redactString — PII patterns", () => {
  it("redacts IPv4 addresses", () => {
    expect(redactString("connect to 192.168.1.10 now").text).toBe(
      "connect to [REDACTED:IPV4] now",
    );
  });

  it("redacts IPv6 addresses", () => {
    expect(redactString("peer 2001:db8::1 replied").text).toBe(
      "peer [REDACTED:IPV6] replied",
    );
  });

  it("redacts a compressed IPv6 loopback address", () => {
    expect(redactString("bind ::1 for local traffic").text).toBe(
      "bind [REDACTED:IPV6] for local traffic",
    );
  });

  it("does not mistake clock times or dates for addresses", () => {
    const input = "happened at 12:34:56 on 2026-09-27";
    expect(redactString(input).text).toBe(input);
  });

  it("redacts email addresses", () => {
    expect(redactString("ping alice@example.com please").text).toBe(
      "ping [REDACTED:EMAIL] please",
    );
  });

  it("redacts phone numbers", () => {
    expect(redactString("call +14155552671").text).toBe("call [REDACTED:PHONE]");
  });

  it("redacts SSNs and payment card numbers", () => {
    expect(redactString("ssn 123-45-6789").text).toBe("ssn [REDACTED:SSN]");
    expect(redactString("card 4111 1111 1111 1111").text).toBe(
      "card [REDACTED:CREDIT_CARD]",
    );
  });

  it("leaves ordinary prose untouched", () => {
    const input = "Claim created for agent 42 in the Stellar Wave programme";
    expect(redactString(input).text).toBe(input);
    expect(redactString(input).findings).toEqual([]);
  });

  it("redacts every occurrence, not every other one", () => {
    const { text, findings } = redactString("1.1.1.1 and 2.2.2.2 and 3.3.3.3");
    expect(text).toBe("[REDACTED:IPV4] and [REDACTED:IPV4] and [REDACTED:IPV4]");
    expect(findings).toEqual([expect.objectContaining({ id: "ipv4", count: 3 })]);
  });

  it("returns empty input unchanged", () => {
    expect(redactString("")).toEqual({ text: "", findings: [] });
  });
});

describe("redactValue — structural redaction", () => {
  it("replaces sensitive keys wholesale", () => {
    const { value, findings } = redactValue({
      password: "hunter2",
      nested: { clientIp: "10.0.0.1" },
      safe: "hello",
    });

    expect(value).toEqual({
      password: "[REDACTED:PASSWORD]",
      nested: { clientIp: "[REDACTED:IP_ADDRESS]" },
      safe: "hello",
    });
    expect(findings.map((finding) => finding.id).sort()).toEqual([
      "key:clientip",
      "key:password",
    ]);
  });

  it("redacts values inside arrays", () => {
    const { value } = redactValue({ ips: ["8.8.8.8", "plain"] });
    expect(value).toEqual({ ips: ["[REDACTED:IPV4]", "plain"] });
  });

  it("survives circular references", () => {
    const cyclic: Record<string, unknown> = { safe: "ok" };
    cyclic.self = cyclic;
    const { value } = redactValue(cyclic);
    expect(value).toEqual({ safe: "ok", self: "[Circular]" });
  });

  it("passes primitives and null through", () => {
    expect(redactValue(42).value).toBe(42);
    expect(redactValue(null).value).toBeNull();
    expect(redactValue(true).value).toBe(true);
  });

  it("supports a custom replacement token", () => {
    const { value } = redactValue(
      { email: "a@b.co" },
      { token: (finding) => `<hidden:${finding.label}>` },
    );
    expect(value).toEqual({ email: "<hidden:EMAIL>" });
  });

  it("scans strings for patterns as well as keys", () => {
    const { value, redactedCount } = redactValue({ note: "ping alice@example.com" });
    expect(value).toEqual({ note: "ping [REDACTED:EMAIL]" });
    expect(redactedCount).toBe(1);
  });
});

describe("redactTimelineEvent", () => {
  it("scrubs description, title and metadata while keeping event identity", () => {
    const { value, findings, redactedCount } = redactTimelineEvent(
      event({
        title: "Payout to G" + "B".repeat(55),
        description: `Settled from 10.0.0.5 by alice@example.com`,
        resourceId: "claim-1",
        metadata: { authorization: "Bearer zzzzzzzzzz", safe: "kept" },
      }),
    );

    expect(value.id).toBe("evt-1");
    expect(value.userId).toBe("user-1");
    expect(value.type).toBe("claim_settled");
    expect(value.redacted).toBe(true);
    expect(value.title).toBe("Payout to [REDACTED:STELLAR_PUBLIC_KEY]");
    expect(value.description).toBe(
      "Settled from [REDACTED:IPV4] by [REDACTED:EMAIL]",
    );
    expect(value.metadata).toEqual({
      authorization: "[REDACTED:AUTHORIZATION]",
      safe: "kept",
    });
    expect(value.redactionCount).toBe(redactedCount);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("leaves a clean event readable and reports zero redactions", () => {
    const { value } = redactTimelineEvent(event());
    expect(value.description).toBe("Your claim was settled.");
    expect(value.redactionCount).toBe(0);
    expect(value.redactionFindings).toEqual([]);
  });

  it("redacts a batch and aggregates findings", () => {
    const { value, findings, redactedCount } = redactTimelineEvents([
      event({ id: "a", description: "from 10.0.0.1" }),
      event({ id: "b", description: "from 10.0.0.2" }),
    ]);
    expect(value).toHaveLength(2);
    expect(redactedCount).toBe(2);
    expect(findings).toEqual([expect.objectContaining({ label: "IPV4", count: 2 })]);
  });

  it("keeps a redacted export free of the original secret", () => {
    const { value } = redactTimelineEvent(
      event({ description: `key ${STELLAR_SECRET} leaked` }),
    );
    const serialised = JSON.stringify(value);
    expect(serialised).not.toContain(STELLAR_SECRET);
    expect(serialised).toContain("[REDACTED:STELLAR_SECRET_KEY]");
  });
});

describe("finding summaries", () => {
  it("describes findings and picks the highest severity", () => {
    const { findings } = redactString("peers 10.0.0.1 and alice@example.com");
    expect(describeFindings(findings)).toMatch(/IPV4/);
    expect(describeFindings(findings)).toMatch(/EMAIL/);
    expect(describeFindings(findings)).toMatch(/×1/);
    expect(highestSeverity(findings)).toBe("high");
  });

  it("handles an empty finding list", () => {
    expect(describeFindings([])).toBe("No sensitive data detected.");
    expect(highestSeverity([])).toBeNull();
  });

  it("rates a JWT as critical", () => {
    const { findings } = redactString(`t=${JWT}`);
    expect(highestSeverity(findings)).toBe("critical");
  });
});

describe("event severity", () => {
  it("maps every event type to a severity", () => {
    for (const type of Object.keys(EVENT_SEVERITY)) {
      expect(isEventSeverity(EVENT_SEVERITY[type as keyof typeof EVENT_SEVERITY])).toBe(true);
    }
  });

  it("derives severity from the event type", () => {
    expect(eventSeverity(event({ type: "claim_rejected" }))).toBe("error");
    expect(eventSeverity(event({ type: "payout_requested" }))).toBe("warning");
    expect(eventSeverity(event({ type: "claim_settled" }))).toBe("success");
    expect(eventSeverity(event({ type: "wallet_connected" }))).toBe("info");
  });

  it("lets metadata override the derived severity", () => {
    expect(eventSeverity(event({ metadata: { severity: "error" } }))).toBe("error");
    expect(eventSeverity(event({ metadata: { severity: "bogus" } }))).toBe("success");
  });
});
