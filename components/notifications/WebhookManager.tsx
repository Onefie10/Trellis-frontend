'use client';

import React, { useState } from 'react';
import { useNotifications } from '@/hooks/useNotifications';
import { WebhookEventTrigger, generateWebhookSecret } from '@/lib/webhooks';

const EVENT_TRIGGERS: { id: WebhookEventTrigger; label: string; description: string }[] = [
  { id: 'new_proposal', label: 'New Proposal', description: 'Triggered when a new governance proposal is created' },
  { id: 'high_error_rate', label: 'High Error Rate', description: 'Triggered when platform or agent error rate spikes' },
  { id: 'payout_executed', label: 'Payout Executed', description: 'Triggered when contract or agent payouts execute' },
  { id: 'agent_minted', label: 'Agent Minted', description: 'Triggered when a new AI agent is deployed on Soroban' },
];

export function WebhookManager() {
  const { webhooks, addWebhook, updateWebhook, deleteWebhook, triggerWebhooks } = useNotifications();

  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState(generateWebhookSecret());
  const [selectedTriggers, setSelectedTriggers] = useState<WebhookEventTrigger[]>([
    'new_proposal',
    'high_error_rate',
    'payout_executed',
    'agent_minted',
  ]);
  const [testResult, setTestResult] = useState<{ endpointId: string; message: string; success: boolean } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [showSecretMap, setShowSecretMap] = useState<Record<string, boolean>>({});

  const handleGenerateSecret = () => {
    setSecret(generateWebhookSecret());
  };

  const handleToggleTrigger = (triggerId: WebhookEventTrigger) => {
    if (selectedTriggers.includes(triggerId)) {
      setSelectedTriggers(selectedTriggers.filter((t) => t !== triggerId));
    } else {
      setSelectedTriggers([...selectedTriggers, triggerId]);
    }
  };

  const handleAddWebhook = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;

    addWebhook({
      name: name.trim(),
      url: url.trim(),
      secret: secret.trim() || generateWebhookSecret(),
      enabled: true,
      triggers: selectedTriggers,
    });

    setName('');
    setUrl('');
    setSecret(generateWebhookSecret());
    setSelectedTriggers(['new_proposal', 'high_error_rate', 'payout_executed', 'agent_minted']);
    setShowAddForm(false);
  };

  const handleTestWebhook = async (endpointId: string) => {
    setTestingId(endpointId);
    setTestResult(null);
    try {
      const endpoint = webhooks.find((w) => w.id === endpointId);
      if (!endpoint) return;

      const triggerToTest = endpoint.triggers[0] || 'new_proposal';
      const results = await triggerWebhooks(triggerToTest, {
        testMessage: 'Outbound webhook verification test',
        sampleData: 'HMAC-SHA256 signature test payload',
      });

      const match = results.find((r) => r.endpointId === endpointId);
      if (match?.success) {
        setTestResult({
          endpointId,
          success: true,
          message: `Webhook delivered successfully! HMAC Signature verified.`,
        });
      } else {
        setTestResult({
          endpointId,
          success: false,
          message: match?.error || 'Dispatch failed. Verify endpoint URL and CORS settings.',
        });
      }
    } catch (err: any) {
      setTestResult({
        endpointId,
        success: false,
        message: err.message || 'Error executing test dispatch',
      });
    } finally {
      setTestingId(null);
    }
  };

  const toggleShowSecret = (id: string) => {
    setShowSecretMap((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-semibold text-white">Outbound Webhooks</h3>
          <p className="text-gray-400 text-sm mt-1">
            Route real-time platform events to external developer webhooks (Discord, Slack, custom endpoints) signed with HMAC-SHA256.
          </p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="px-4 py-2 bg-trellis-vine hover:bg-trellis-vine/80 rounded-lg text-sm font-medium text-white transition-colors flex items-center gap-2"
        >
          {showAddForm ? 'Cancel' : '+ Add Webhook Endpoint'}
        </button>
      </div>

      {/* Add Webhook Form */}
      {showAddForm && (
        <form onSubmit={handleAddWebhook} className="p-5 rounded-lg border border-trellis-vine/40 bg-trellis-vine/10 space-y-4">
          <h4 className="text-base font-semibold text-white">Register New Webhook Endpoint</h4>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Endpoint Name</label>
            <input
              type="text"
              required
              placeholder="e.g., Maintainer Discord Webhook"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:border-trellis-vine"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Target Webhook URL</label>
            <input
              type="url"
              required
              placeholder="https://discord.com/api/webhooks/... or https://your-domain.com/webhook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:border-trellis-vine"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-gray-300">HMAC-SHA256 Secret Key</label>
              <button
                type="button"
                onClick={handleGenerateSecret}
                className="text-xs text-trellis-leaf hover:underline"
              >
                Generate New Secret
              </button>
            </div>
            <input
              type="text"
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm font-mono focus:outline-none focus:border-trellis-vine"
            />
            <p className="text-xs text-gray-400 mt-1">
              Used to generate the <code className="text-trellis-leaf">X-Trellis-Signature: sha256=...</code> HMAC header for payload authentication.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Event Triggers</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {EVENT_TRIGGERS.map(({ id, label, description }) => (
                <label key={id} className="flex items-start gap-3 p-3 rounded-lg border border-white/10 bg-white/5 cursor-pointer hover:bg-white/10 transition">
                  <input
                    type="checkbox"
                    checked={selectedTriggers.includes(id)}
                    onChange={() => handleToggleTrigger(id)}
                    className="mt-1 rounded bg-gray-700 border-gray-600 text-trellis-vine focus:ring-trellis-vine"
                  />
                  <div>
                    <span className="text-sm font-medium text-white block">{label}</span>
                    <span className="text-xs text-gray-400">{description}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-white/5 hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-lg text-sm font-medium text-white bg-trellis-vine hover:bg-trellis-vine/80"
            >
              Save Webhook Endpoint
            </button>
          </div>
        </form>
      )}

      {/* Webhook Endpoints List */}
      <div className="space-y-4">
        {webhooks.length === 0 ? (
          <div className="p-8 text-center rounded-lg border border-dashed border-white/20 bg-white/5">
            <p className="text-gray-400 text-sm">No webhook endpoints configured yet.</p>
            <p className="text-gray-500 text-xs mt-1">Click &quot;Add Webhook Endpoint&quot; above to connect Discord, Slack, or custom HTTP endpoints.</p>
          </div>
        ) : (
          webhooks.map((w) => (
            <div key={w.id} className="p-5 rounded-lg border border-white/10 bg-white/5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-3">
                    <h4 className="text-base font-semibold text-white">{w.name}</h4>
                    <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                      w.enabled ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-gray-500/20 text-gray-400 border border-gray-500/30'
                    }`}>
                      {w.enabled ? 'Active' : 'Disabled'}
                    </span>
                    {w.lastStatus && (
                      <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                        w.lastStatus === 'success' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-red-900/40 text-red-300'
                      }`}>
                        Last: {w.lastStatus}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 font-mono mt-1 break-all">{w.url}</p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTestWebhook(w.id)}
                    disabled={testingId === w.id || !w.enabled}
                    className="px-3 py-1.5 text-xs font-medium bg-trellis-vine/20 hover:bg-trellis-vine/40 border border-trellis-vine/40 text-trellis-vine rounded-lg transition disabled:opacity-50"
                  >
                    {testingId === w.id ? 'Sending...' : 'Test Webhook'}
                  </button>

                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={w.enabled}
                      onChange={(e) => updateWebhook(w.id, { enabled: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-trellis-vine" />
                  </label>

                  <button
                    onClick={() => deleteWebhook(w.id)}
                    className="p-1.5 text-gray-400 hover:text-red-400 rounded-lg hover:bg-white/5 transition"
                    title="Delete Webhook"
                  >
                    🗑️
                  </button>
                </div>
              </div>

              {/* Secret display */}
              <div className="flex items-center justify-between p-2.5 rounded bg-black/40 border border-white/5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 font-medium">HMAC Secret:</span>
                  <span className="font-mono text-gray-300">
                    {showSecretMap[w.id] ? w.secret : '••••••••••••••••••••••••••••••••'}
                  </span>
                </div>
                <button
                  onClick={() => toggleShowSecret(w.id)}
                  className="text-trellis-leaf hover:underline text-xs"
                >
                  {showSecretMap[w.id] ? 'Hide' : 'Show'}
                </button>
              </div>

              {/* Trigger Checkboxes for endpoint */}
              <div>
                <p className="text-xs font-medium text-gray-300 mb-2">Active Event Triggers:</p>
                <div className="flex flex-wrap gap-2">
                  {EVENT_TRIGGERS.map(({ id, label }) => {
                    const active = w.triggers.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          const updated = active
                            ? w.triggers.filter((t) => t !== id)
                            : [...w.triggers, id];
                          updateWebhook(w.id, { triggers: updated });
                        }}
                        className={`px-2.5 py-1 text-xs rounded-full border transition flex items-center gap-1.5 ${
                          active
                            ? 'bg-trellis-vine/20 text-white border-trellis-vine/60'
                            : 'bg-white/5 text-gray-400 border-white/10 hover:text-gray-200'
                        }`}
                      >
                        <span>{active ? '✓' : '+'}</span>
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Test result feedback banner */}
              {testResult && testResult.endpointId === w.id && (
                <div className={`p-3 rounded text-xs border ${
                  testResult.success ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300' : 'bg-red-950/60 border-red-700/60 text-red-300'
                }`}>
                  {testResult.message}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
