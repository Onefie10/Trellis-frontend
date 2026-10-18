"use client";

import React from "react";
import { useNotifications } from "@/hooks/useNotifications";

export function NotificationPreferencePanel() {
  const {
    permission,
    isSupported,
    preferences,
    requestPermission,
    updatePreferences,
    subscribeToPush,
    unsubscribeFromPush,
    isSubscribed,
  } = useNotifications();

  const [isRequestingPermission, setIsRequestingPermission] = React.useState(false);
  const [isSubscribing, setIsSubscribing] = React.useState(false);

  const handleRequestPermission = async () => {
    setIsRequestingPermission(true);
    try {
      await requestPermission();
    } catch (error) {
      console.error("Failed to request permission:", error);
    } finally {
      setIsRequestingPermission(false);
    }
  };

  const handleSubscribeToPush = async () => {
    setIsSubscribing(true);
    try {
      await subscribeToPush();
    } catch (error) {
      console.error("Failed to subscribe to push:", error);
    } finally {
      setIsSubscribing(false);
    }
  };

  const handleUnsubscribeFromPush = async () => {
    setIsSubscribing(true);
    try {
      await unsubscribeFromPush();
    } catch (error) {
      console.error("Failed to unsubscribe from push:", error);
    } finally {
      setIsSubscribing(false);
    }
  };

  const handleToggleCategory = (category: string) => {
    const current = preferences.eventCategories[category];
    updatePreferences({
      eventCategories: { [category]: !current },
    });
  };

  if (!isSupported) {
    return (
      <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10">
        <p className="text-red-400 text-sm">
          Notifications are not supported in your browser.
        </p>
      </div>
    );
  }

  const categories = [
    { key: "proposal_passing", label: "Proposal Passing", description: "Get notified when governance proposals pass" },
    { key: "payout_execution", label: "Payout Execution", description: "Alerts when payouts are executed" },
    { key: "agent_error", label: "Agent Errors", description: "Notifications when AI agents encounter errors" },
    { key: "governance", label: "Governance", description: "Governance-related updates and votes" },
    { key: "security_alert", label: "Security Alerts", description: "Critical security notifications" },
    { key: "trade_complete", label: "Trade Complete", description: "Trade execution notifications" },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-white">Web Push Notifications</h3>

        <div className="flex items-center justify-between p-4 rounded-lg border border-white/10 bg-white/5">
          <div>
            <p className="text-white font-medium">Browser Permission</p>
            <p className="text-gray-400 text-sm">
              Status:{" "}
              <span className={permission === "granted" ? "text-green-400" : permission === "denied" ? "text-red-400" : "text-yellow-400"}>
                {permission === "granted" ? "Granted" : permission === "denied" ? "Blocked" : "Not Requested"}
              </span>
            </p>
          </div>
          {permission === "default" && (
            <button
              onClick={handleRequestPermission}
              disabled={isRequestingPermission}
              className="px-4 py-2 bg-trellis-vine hover:bg-trellis-vine/80 rounded-lg font-medium text-white transition-colors disabled:opacity-50"
            >
              {isRequestingPermission ? "Requesting..." : "Enable Notifications"}
            </button>
          )}
          {permission === "denied" && (
            <div className="text-right">
              <p className="text-red-400 text-sm">Blocked in browser settings</p>
            </div>
          )}
        </div>

        {permission === "granted" && (
          <div className="flex items-center justify-between p-4 rounded-lg border border-white/10 bg-white/5">
            <div>
              <p className="text-white font-medium">Push Subscription</p>
              <p className="text-gray-400 text-sm">
                Receive notifications even when the app is closed
              </p>
            </div>
            {!isSubscribed ? (
              <button
                onClick={handleSubscribeToPush}
                disabled={isSubscribing}
                className="px-4 py-2 bg-trellis-vine hover:bg-trellis-vine/80 rounded-lg font-medium text-white transition-colors disabled:opacity-50"
              >
                {isSubscribing ? "Subscribing..." : "Subscribe"}
              </button>
            ) : (
              <button
                onClick={handleUnsubscribeFromPush}
                disabled={isSubscribing}
                className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 rounded-lg font-medium text-red-400 transition-colors disabled:opacity-50"
              >
                {isSubscribing ? "Unsubscribing..." : "Unsubscribe"}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-white">Event Categories</h3>
        <p className="text-gray-400 text-sm">Toggle push alerts per event category</p>

        <div className="space-y-2">
          {categories.map(({ key, label, description }) => (
            <div
              key={key}
              className="flex items-center justify-between p-4 rounded-lg border border-white/10 bg-white/5"
            >
              <div>
                <p className="text-white font-medium">{label}</p>
                <p className="text-gray-400 text-xs">{description}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={preferences.eventCategories[key] !== false}
                  onChange={() => handleToggleCategory(key)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-trellis-vine" />
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
