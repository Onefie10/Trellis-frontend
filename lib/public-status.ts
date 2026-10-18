import type { ServiceHealthStatus } from "@/lib/operational-health";

export type PublicStatus = "operational" | "degraded" | "paused" | "maintenance";
export type PublicStatusOverride = Extract<PublicStatus, "paused" | "maintenance">;

export interface PublicStatusSnapshot {
  status: PublicStatus;
  updatedAt: string;
  affectedServices: number;
  message: string;
}

const PUBLIC_MESSAGES: Record<PublicStatus, string> = {
  operational: "All monitored services are operating normally.",
  degraded: "Some services are experiencing delays or interruptions.",
  paused: "Some operations are temporarily paused.",
  maintenance: "Scheduled maintenance is in progress.",
};

export function parsePublicStatusOverride(value: unknown): PublicStatusOverride | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "paused" || normalized === "maintenance" ? normalized : undefined;
}

/** Build an allowlisted public projection; internal endpoints and probe errors never leave the server. */
export function buildPublicStatus(
  services: readonly { status: ServiceHealthStatus }[],
  options: { override?: unknown; now?: number } = {},
): PublicStatusSnapshot {
  const affectedServices = services.filter((service) => service.status !== "healthy").length;
  const status = parsePublicStatusOverride(options.override) ??
    (affectedServices > 0 ? "degraded" : "operational");

  return {
    status,
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
    affectedServices,
    message: PUBLIC_MESSAGES[status],
  };
}
