'use client';

import React from 'react';
import { MaintainerApprovalReviewDashboard } from '@/components/maintainer/MaintainerApprovalReviewDashboard';
import { usePWA } from '@/hooks/usePWA';

export default function MaintainerApprovalsPage() {
  const { isOnline } = usePWA();

  const mockMaintainer = {
    id: 'maintainer-active-session',
    publicKey: 'GBZXN7PIRZGNMHGA728RGRYA7ROVOP36Q4F6WMT6I2Q3OEXZJTY2T',
    role: 'maintainer' as const,
    walletType: 'freighter' as const,
  };

  return (
    <main className="min-h-screen bg-zinc-950 p-6 md:p-10">
      <div className="max-w-7xl mx-auto">
        <MaintainerApprovalReviewDashboard
          reviewer={mockMaintainer}
          isOffline={!isOnline}
        />
      </div>
    </main>
  );
}
