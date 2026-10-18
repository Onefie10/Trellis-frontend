import React from 'react';
import { PluginManifest } from '../sandbox/manifestValidator';
import { ShieldAlert } from 'lucide-react';

interface PermissionModalProps {
  manifest: PluginManifest;
  onApprove: () => void;
  onDeny: () => void;
}

export const PermissionModal: React.FC<PermissionModalProps> = ({ manifest, onApprove, onDeny }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#111114] p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-5">
          <ShieldAlert className="h-6 w-6 text-amber-400" />
          <h2 className="text-base font-semibold text-white">Approve Plugin Activation</h2>
        </div>
        <div className="space-y-3 text-sm text-zinc-300">
          <p>
            The plugin <span className="font-semibold text-white">{manifest.name}</span> (v{manifest.version}) is requesting the following permissions:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            {manifest.permissions.map((p) => (
              <li key={p} className="font-mono text-xs text-amber-400">{p}</li>
            ))}
          </ul>
          <p className="text-xs text-zinc-500 mt-2">
            Warning: High-privilege plugins can access sensitive data. Only approve if you trust the author.
          </p>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onDeny}
            className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition"
            data-testid="deny-permission-btn"
          >
            Deny
          </button>
          <button
            onClick={onApprove}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500"
            data-testid="approve-permission-btn"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
};
