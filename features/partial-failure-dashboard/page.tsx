'use client';

import { PartialFailureDashboard } from './PartialFailureDashboard';

/**
 * Partial Failure Dashboard Page
 *
 * This page provides the main entry point for the partial failure dashboard.
 * It wraps the dashboard component and provides any additional page-level
 * layout or functionality.
 */
export default function PartialFailureDashboardPage() {
  return (
    <main className="min-h-screen px-4 py-12 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <PartialFailureDashboard />
      </div>
    </main>
  );
}
