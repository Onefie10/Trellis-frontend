import type { ExternalServiceHealth, ExternalServiceKey, ServiceHealthStatus } from "@/lib/operational-health";

export interface DependencyFallbackGuidance {
  service: ExternalServiceKey;
  label: string;
  status: Exclude<ServiceHealthStatus, "healthy">;
  userMessage: string;
  fallback: string;
  recovery: string;
}

/**
 * Safe fallback contract for every third-party dependency monitored by the
 * operational health probe. Keep provider URLs and raw errors out of this map.
 */
export const DEPENDENCY_DEGRADATION_MATRIX: Readonly<
  Record<ExternalServiceKey, Omit<DependencyFallbackGuidance, "status">>
> = {
  horizon: {
    service: "horizon",
    label: "Stellar Horizon",
    userMessage: "Stellar account data may be delayed. Refresh before taking action.",
    fallback: "Keep the last loaded balance visibly stale and pause transaction submission until the selected network can confirm state.",
    recovery: "Check the configured Horizon endpoint and network status, then refresh account data. Require ledger confirmation before showing a transaction as complete.",
  },
  "soroban-rpc": {
    service: "soroban-rpc",
    label: "Soroban RPC",
    userMessage: "Smart contract data is temporarily unavailable.",
    fallback: "Keep read-only cached data labeled as stale, disable contract actions that require a fresh simulation, and never report an unconfirmed transaction as successful.",
    recovery: "Check the RPC endpoint and simulation health. Refresh state and simulate again before re-enabling contract actions.",
  },
  ipfs: {
    service: "ipfs",
    label: "IPFS metadata",
    userMessage: "Some agent details may be unavailable right now.",
    fallback: "Use only previously verified cached metadata. Show an unavailable state for missing content; do not substitute unverified metadata or treat a missing document as an empty one.",
    recovery: "Check the configured gateway and CID availability, then refresh the missing metadata. Keep issuer and content verification results attached to cached data.",
  },
  algolia: {
    service: "algolia",
    label: "Marketplace search",
    userMessage: "Marketplace search is temporarily limited.",
    fallback: "Keep the current page usable and show a retryable search-unavailable message. Do not present a provider failure as a successful search with zero matches.",
    recovery: "Check the search service and configured index. Retry the query after health recovers and report the updated result count.",
  },
};

export function getDependencyFallbackGuidance(
  service: string,
  status: ServiceHealthStatus,
): DependencyFallbackGuidance | null {
  if (status === "healthy") return null;
  if (!Object.prototype.hasOwnProperty.call(DEPENDENCY_DEGRADATION_MATRIX, service)) return null;
  const policy = DEPENDENCY_DEGRADATION_MATRIX[service as ExternalServiceKey];
  return { ...policy, status };
}

/** Returns redacted guidance only; never forwards probe endpoints or errors. */
export function buildDependencyFallbacks(
  services: readonly Pick<ExternalServiceHealth, "service" | "status">[],
): DependencyFallbackGuidance[] {
  return services.flatMap((service) => {
    const guidance = getDependencyFallbackGuidance(service.service, service.status);
    return guidance ? [guidance] : [];
  });
}
