import { NextResponse } from "next/server";
import { syntheticProbeManager } from "@/lib/operational-health";
import { buildPublicStatus } from "@/lib/public-status";

export const dynamic = "force-dynamic";

const MIN_PROBE_INTERVAL_MS = 30_000;
let lastProbeAt = 0;
let probeInFlight: Promise<unknown> | null = null;

async function refreshProbeSnapshot(now: number): Promise<void> {
  if (now - lastProbeAt < MIN_PROBE_INTERVAL_MS) return;
  if (!probeInFlight) {
    probeInFlight = syntheticProbeManager.runProbes().then(() => {
      lastProbeAt = Date.now();
    }).finally(() => {
      probeInFlight = null;
    });
  }
  await probeInFlight;
}

export async function GET() {
  await refreshProbeSnapshot(Date.now());
  const snapshot = buildPublicStatus(
    syntheticProbeManager.getAllServicesHealth(),
    { override: process.env.TRELLIS_PUBLIC_STATUS_MODE },
  );

  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
