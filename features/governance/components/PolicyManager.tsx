'use client';

import React, { useState } from 'react';
import { Policy, quotaService } from '../../agent-telemetry/services/quotaService';
import { simulatePolicyChange, type PolicySimulation } from '@/lib/governance/policySimulation';

export const PolicyManager: React.FC = () => {
  const [policies, setPolicies] = useState<Policy[]>([
    { id: '1', name: 'Free Tier', quotaLimit: 1000, rateLimit: 2, description: 'Basic access for non-commercial use.' },
    { id: '2', name: 'Pro Tier', quotaLimit: 10000, rateLimit: 10, description: 'High-throughput access for production deployments.' },
    { id: '3', name: 'Enterprise Tier', quotaLimit: 100000, rateLimit: 50, description: 'Dedicated resources for enterprise scale.' },
  ]);
  const [editingPolicy, setEditingPolicy] = useState<Policy | null>(null);
  const [preview, setPreview] = useState<{ current: Policy; draft: Policy; result: PolicySimulation } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handlePreview = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPolicy) return;
    const current = policies.find((policy) => policy.id === editingPolicy.id);
    if (!current) return;

    setSaveError(null);
    setPreview({ current, draft: { ...editingPolicy }, result: simulatePolicyChange(current, editingPolicy) });
  };

  const handleApply = async () => {
    const pendingPreview = preview;
    if (!pendingPreview?.result.valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await quotaService.updatePolicy(pendingPreview.draft);
      if (!saved) throw new Error('The policy service did not confirm the update.');
      setPolicies((previous) => previous.map((policy) => policy.id === pendingPreview.draft.id ? pendingPreview.draft : policy));
      setEditingPolicy(null);
      setPreview(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to apply the policy. Your draft is still available to retry.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-12">
      <h2 className="text-3xl font-extrabold mb-8 bg-clip-text text-transparent bg-gradient-to-r from-trellis-vine to-trellis-leaf">
        Governance & Policy Management
      </h2>

      <div className="grid lg:grid-cols-3 gap-8">
        {/* Policy List */}
        <div className="lg:col-span-2 space-y-4">
          {policies.map((policy) => (
            <div 
              key={policy.id} 
              className="p-6 rounded-xl border border-white/5 bg-white/5 backdrop-blur-md flex justify-between items-center transition-all hover:border-trellis-vine/30 group"
            >
              <div>
                <h4 className="text-xl font-bold text-white mb-1">{policy.name}</h4>
                <p className="text-xs text-gray-400 mb-3">{policy.description}</p>
                <div className="flex gap-4">
                  <span className="text-[10px] uppercase font-bold text-trellis-amber flex items-center gap-1">
                    <span className="text-sm">🎫</span> {policy.quotaLimit.toLocaleString()} Requests/Day
                  </span>
                  <span className="text-[10px] uppercase font-bold text-trellis-vine flex items-center gap-1">
                    <span className="text-sm">⚡</span> {policy.rateLimit} Req/Sec
                  </span>
                </div>
              </div>
              <button 
                onClick={() => { setEditingPolicy({...policy}); setPreview(null); setSaveError(null); }}
                className="px-4 py-2 bg-white/10 hover:bg-trellis-vine/30 border border-white/10 rounded-lg text-xs font-bold transition-smooth"
              >
                Edit Policy
              </button>
            </div>
          ))}
        </div>

        {/* Edit Form Card */}
        <div className="h-fit">
          <div className="p-8 rounded-2xl border border-white/10 bg-[#0d122b] sticky top-24 shadow-2xl">
             <h3 className="text-lg font-bold mb-6 text-white flex items-center gap-2">
                <span className="w-1.5 h-6 bg-trellis-amber rounded-full" />
                {editingPolicy ? `Updating: ${editingPolicy.name}` : 'Select a Policy to Manage'}
             </h3>

             {editingPolicy ? (
               <form onSubmit={handlePreview} className="space-y-6">
                 <div>
                   <label className="block text-[10px] uppercase font-black text-gray-500 mb-2">Daily Quota Limit</label>
                   <input
                     min="1"
                     step="1"
                     type="number" 
                     className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white focus:outline-none focus:border-trellis-amber transition-colors"
                     value={editingPolicy.quotaLimit}
                      onChange={(e) => { setEditingPolicy({...editingPolicy, quotaLimit: Number(e.target.value)}); setPreview(null); }}
                   />
                 </div>
                 <div>
                    <label className="block text-[10px] uppercase font-black text-gray-500 mb-2">Rate Limit (req/s)</label>
                    <input
                      min="1"
                      step="1"
                      type="number" 
                      className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white focus:outline-none focus:border-trellis-amber transition-colors"
                      value={editingPolicy.rateLimit}
                      onChange={(e) => { setEditingPolicy({...editingPolicy, rateLimit: Number(e.target.value)}); setPreview(null); }}
                    />
                 </div>
                 <div className="pt-4 flex gap-3">
                   <button 
                     type="submit" 
                     className="flex-1 py-3 bg-trellis-vine hover:bg-trellis-leaf text-white rounded-xl text-xs font-bold transition-smooth shadow-lg shadow-trellis-vine/20"
                   >
                     Preview Change
                   </button>
                   <button 
                     type="button" 
                     onClick={() => { setEditingPolicy(null); setPreview(null); setSaveError(null); }}
                     className="px-4 py-3 bg-white/5 hover:bg-red-500/20 text-gray-400 hover:text-red-400 rounded-xl text-xs font-bold transition-smooth"
                   >
                     Cancel
                   </button>
                 </div>
                 {preview && (
                   <section aria-label="Policy change simulation" className="rounded-xl border border-trellis-amber/30 bg-trellis-amber/5 p-4 space-y-3">
                     <h4 className="text-sm font-bold text-white">Simulation preview</h4>
                     {preview.result.errors.length > 0 ? (
                       <ul role="alert" className="list-disc pl-5 text-xs text-red-300">
                         {preview.result.errors.map((error) => <li key={error}>{error}</li>)}
                       </ul>
                     ) : (
                       <>
                         <p className="text-xs text-gray-300">Daily quota: {preview.current.quotaLimit.toLocaleString()} → {preview.draft.quotaLimit.toLocaleString()} ({preview.result.quotaChangePercent > 0 ? '+' : ''}{preview.result.quotaChangePercent.toFixed(0)}%)</p>
                         <p className="text-xs text-gray-300">Rate limit: {preview.current.rateLimit} → {preview.draft.rateLimit} req/s ({preview.result.rateChangePercent > 0 ? '+' : ''}{preview.result.rateChangePercent.toFixed(0)}%)</p>
                         <p className="text-xs text-gray-400">This preview compares configured limits only; it does not predict demand or guarantee service capacity.</p>
                         {preview.result.highImpact && <p role="status" className="text-xs font-semibold text-trellis-amber">High impact: at least one limit changes by 25% or more. Review the values before applying.</p>}
                         {saveError && <p role="alert" className="text-xs text-red-300">{saveError} You can retry or cancel; the saved policy has not been changed in this view.</p>}
                         <div className="flex gap-3 pt-1">
                           <button type="button" onClick={handleApply} disabled={saving} className="flex-1 py-2 bg-trellis-vine hover:bg-trellis-leaf disabled:opacity-50 text-white rounded-lg text-xs font-bold">
                             {saving ? 'Applying…' : 'Confirm and apply'}
                           </button>
                           <button type="button" onClick={() => { setPreview(null); setSaveError(null); }} className="px-3 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg text-xs font-bold">Back to edit</button>
                         </div>
                       </>
                     )}
                   </section>
                 )}
                 {!preview && saveError && <p role="alert" className="text-xs text-red-300">{saveError}</p>}
               </form>
             ) : (
                <div className="py-20 text-center border-2 border-dashed border-white/5 rounded-xl">
                    <p className="text-xs text-gray-500 px-8">
                        The planetary governance system is awaiting instructions. Select a policy to recalibrate its limits.
                    </p>
                </div>
             )}
          </div>
        </div>
      </div>
    </div>
  );
};
