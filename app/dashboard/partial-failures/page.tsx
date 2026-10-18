'use client';

import { PartialFailureDashboard } from '@/features/partial-failure-dashboard/PartialFailureDashboard';

/**
 * Partial Failure Dashboard Page
 *
 * This page provides the main entry point for the partial failure dashboard
 * within the existing dashboard structure.
 */
export default function PartialFailuresPage() {
  return (
    <main className="min-h-screen px-4 py-12 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-10">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-trellis-leaf">
            Maintainer operations
          </p>
          <h1 className="mt-3 text-4xl font-bold">Partial Failures</h1>
          <p className="mt-3 max-w-2xl text-gray-300">
            Monitor and manage unresolved partial failures from async jobs, integrations, and user-visible operations.
          </p>
        </header>
        <PartialFailureDashboard />
      </div>
    </main>
  );
}
