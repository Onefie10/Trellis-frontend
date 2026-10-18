/**
 * Who a request belongs to.
 *
 * A signed-in caller is bucketed by its token; everyone else falls back to the
 * client IP. Three rules make it abuse-resistant:
 *
 *   1. `x-forwarded-for` is read from the **right**, not the left. The leftmost
 *      entry is whatever the client sent; the rightmost is what the trusted edge
 *      appended. `trustProxyHops` moves further left when more proxies are ours.
 *   2. A request with no usable identifier lands in one shared `anonymous`
 *      bucket instead of bypassing the limit.
 *   3. Identifiers are hashed before they are used as a key, so raw tokens and
 *      IPs never end up in the store, in logs or in a response header.
 */

export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

export interface ClientIpResult {
  ip: string | null;
  /** Which header produced the value — useful for diagnostics. */
  source: "x-forwarded-for" | "x-real-ip" | "cf-connecting-ip" | "x-vercel-forwarded-for" | "none";
}

export interface IdentityOptions {
  /**
   * Number of proxies you control in front of the app. 0 (the default) means
   * "take the value our edge appended", i.e. the rightmost entry.
   */
  trustProxyHops?: number;
}

export interface ResolvedIdentity {
  key: string;
  kind: "token" | "ip" | "anonymous";
  /**
   * Raw client IP when one was resolved. Never persisted — it exists so callers
   * can exempt localhost without weakening the hashed store key.
   */
  ip: string | null;
}

const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/;
const BRACKETED_IPV6 = /^\[(.+)\]:\d+$/;

/** `Headers` and plain objects both reach this module, so normalise the lookup. */
export function headerLookup(headers: HeaderSource): (name: string) => string | null {
  if (typeof (headers as Headers).get === "function") {
    const h = headers as Headers;
    return (name: string) => h.get(name);
  }

  const record = (headers ?? {}) as Record<string, string | string[] | undefined>;
  return (name: string) => {
    const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
    if (direct === undefined) return null;
    return Array.isArray(direct) ? (direct[0] ?? null) : (direct || null);
  };
}

/**
 * Trims whitespace and removes a transport port, so `[::1]:3000` and `::1`
 * share one bucket. Returns `null` for values that cannot be an address.
 */
export function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim();
  if (candidate === "") return null;

  const bracketed = BRACKETED_IPV6.exec(candidate);
  if (bracketed) candidate = bracketed[1];

  const withPort = IPV4_WITH_PORT.exec(candidate);
  if (withPort) candidate = withPort[1];

  // Reject anything with characters that cannot appear in an IPv4/IPv6 literal;
  // a header full of junk must not become a bucket key.
  if (!/^[0-9a-fA-F.:]+$/.test(candidate)) return null;
  return candidate.toLowerCase();
}

/**
 * Resolves the client IP, preferring the hop our own edge appended.
 *
 * `trustProxyHops: 1` moves one entry further left, for deployments with an
 * extra load balancer in front of the Next.js server.
 */
export function clientIp(
  headers: HeaderSource,
  options: IdentityOptions = {},
): ClientIpResult {
  const get = headerLookup(headers);
  const hops = Math.max(0, Math.trunc(options.trustProxyHops ?? 0));

  const forwarded = get("x-forwarded-for");
  if (forwarded) {
    const chain = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");

    if (chain.length > 0) {
      const index = Math.max(0, chain.length - 1 - hops);
      const ip = normaliseIp(chain[index]);
      if (ip) return { ip, source: "x-forwarded-for" };
    }
  }

  const direct = normaliseIp(get("x-real-ip"));
  if (direct) return { ip: direct, source: "x-real-ip" };

  const cloudflare = normaliseIp(get("cf-connecting-ip"));
  if (cloudflare) return { ip: cloudflare, source: "cf-connecting-ip" };

  const vercel = normaliseIp(get("x-vercel-forwarded-for"));
  if (vercel) return { ip: vercel, source: "x-vercel-forwarded-for" };

  return { ip: null, source: "none" };
}

/** Extracts a `Bearer` token, or `null` when the header is absent/malformed. */
export function bearerToken(headers: HeaderSource): string | null {
  const authorization = headerLookup(headers)("authorization");
  if (!authorization) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;

  const token = match[1].trim();
  return token === "" ? null : token;
}

/** `x-api-key`, used by the affiliate and ops endpoints. */
export function apiKey(headers: HeaderSource): string | null {
  const value = headerLookup(headers)("x-api-key");
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * FNV-1a (32-bit) rendered as hex.
 *
 * This is a bucketing key, not a password hash: it exists so the store never
 * holds a raw token or IP, and it is intentionally cheap because middleware runs
 * on every request. Collisions only merge two buckets and cost the caller
 * tokens, they never leak or grant anything.
 */
export function hashIdentifier(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Bucket identity for a request.
 *
 * Token wins over IP so two users behind one NAT do not share a budget, and so
 * a token cannot dodge its limit by rotating IPs.
 */
export function resolveIdentity(
  headers: HeaderSource,
  options: IdentityOptions = {},
): ResolvedIdentity {
  const token = bearerToken(headers) ?? apiKey(headers);
  if (token) {
    const { ip } = clientIp(headers, options);
    return { key: `token:${hashIdentifier(token)}`, kind: "token", ip };
  }

  const { ip } = clientIp(headers, options);
  if (ip) {
    return { key: `ip:${hashIdentifier(ip)}`, kind: "ip", ip };
  }

  return { key: "anonymous", kind: "anonymous", ip: null };
}
