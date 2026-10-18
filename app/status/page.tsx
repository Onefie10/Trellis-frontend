"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicStatusSnapshot } from "@/lib/public-status";

const REFRESH_INTERVAL_MS = 30_000;

const STATUS_STYLE: Record<PublicStatusSnapshot["status"], string> = {
  operational: "border-emerald-400/40 bg-emerald-400/10 text-emerald-100",
  degraded: "border-amber-400/40 bg-amber-400/10 text-amber-100",
  paused: "border-orange-400/40 bg-orange-400/10 text-orange-100",
  maintenance: "border-sky-400/40 bg-sky-400/10 text-sky-100",
};

export default function PublicStatusPage() {
  const [snapshot, setSnapshot] = useState<PublicStatusSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/public-status", { cache: "no-store" });
      if (!response.ok) throw new Error("Status request failed");
      setSnapshot(await response.json() as PublicStatusSnapshot);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16 text-white">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">Trellis service status</p>
      <h1 className="mt-3 text-4xl font-bold">System availability</h1>
      <section className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6" aria-live="polite">
        {snapshot ? (
          <>
            <p className={`inline-flex rounded-full border px-3 py-1 text-sm font-semibold capitalize ${STATUS_STYLE[snapshot.status]}`}>
              {snapshot.status}
            </p>
            <p className="mt-4 text-lg">{snapshot.message}</p>
            {snapshot.affectedServices > 0 && (
              <p className="mt-2 text-sm text-white/70">
                {snapshot.affectedServices} monitored {snapshot.affectedServices === 1 ? "service is" : "services are"} affected.
              </p>
            )}
            <p className="mt-4 text-xs text-white/50">
              Updated {new Date(snapshot.updatedAt).toLocaleString()} · Refreshes every 30 seconds
            </p>
          </>
        ) : (
          <p className="text-white/70">{unavailable ? "Status is temporarily unavailable." : "Loading current status…"}</p>
        )}
      </section>
    </main>
  );
}
