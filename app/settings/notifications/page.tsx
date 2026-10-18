'use client';

import { NotificationSettings } from '@/components/NotificationSettings';
import { NotificationDemo } from '@/components/NotificationDemo';
import { AlertPreferencesPanel } from '@/components/notifications/AlertPreferencesPanel';
import { NotificationPreferencePanel } from '@/components/notifications/NotificationPreferencePanel';
import { WebhookManager } from '@/components/notifications/WebhookManager';
import { EmailDigestSettings } from '@/components/notifications/EmailDigestSettings';

export default function NotificationSettingsPage() {
  return (
    <main className="pt-20 pb-20 px-4 min-h-screen">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-4xl font-bold text-white mb-4">Notification Settings</h1>
          <p className="text-gray-300 text-lg">
            Manage your notification preferences, outbound developer webhooks, and email digest reports.
          </p>
        </div>

        <AlertPreferencesPanel className="mb-8" />

        <NotificationSettings className="mb-8" />
        
        <div className="mb-8">
          <NotificationPreferencePanel />
        </div>

        <div className="p-6 rounded-xl border border-white/10 bg-white/5">
          <WebhookManager />
        </div>

        <div className="p-6 rounded-xl border border-white/10 bg-white/5">
          <EmailDigestSettings />
        </div>

        <NotificationDemo />

        {/* Additional Information */}
        <div className="space-y-6">
          <div className="p-6 rounded-lg border border-trellis-vine/30 bg-trellis-vine/10">
            <h2 className="text-xl font-semibold text-white mb-3">About Notifications</h2>
            <div className="space-y-3 text-gray-300">
              <p>
                <strong>Trade Notifications:</strong> Get real-time updates when your trades are executed or fail.
              </p>
              <p>
                <strong>Transaction Notifications:</strong> Receive alerts for general blockchain transactions.
              </p>
              <p>
                <strong>Push Notifications:</strong> Enable to receive notifications even when the app is closed.
              </p>
              <p>
                <strong>Audio Alerts:</strong> Success, warning and critical severity chimes, with a per-severity preview.
              </p>
              <p>
                <strong>Quiet Hours:</strong> Set specific times when notifications should be silenced. Critical alerts still come through unless you also mute them.
              </p>
              <p>
                <strong>Category Mutes:</strong> Silence trading, governance, security or system alerts independently.
              </p>
            </div>
          </div>

          <div className="p-6 rounded-lg border border-trellis-leaf/30 bg-trellis-leaf/10">
            <h2 className="text-xl font-semibold text-white mb-3">Privacy & Security</h2>
            <div className="space-y-3 text-gray-300">
              <p>
                • All notifications are processed locally on your device
              </p>
              <p>
                • No personal data is shared with third-party services
              </p>
              <p>
                • You can disable notifications at any time
              </p>
              <p>
                • Push subscriptions can be revoked instantly
              </p>
            </div>
          </div>

          <div className="p-6 rounded-lg border border-yellow-500/30 bg-yellow-500/10">
            <h2 className="text-xl font-semibold text-white mb-3">Troubleshooting</h2>
            <div className="space-y-3 text-gray-300">
              <p>
                <strong>Notifications not showing?</strong> Check your browser settings and ensure notifications are allowed for this site.
              </p>
              <p>
                <strong>Push not working?</strong> Make sure your browser supports push notifications and you&apos;re online.
              </p>
              <p>
                <strong>Still having issues?</strong> Try refreshing the page or restarting your browser.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
