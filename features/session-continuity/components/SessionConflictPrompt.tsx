"use client";

import { SessionSyncMessage } from '../tab-sync';

export function SessionConflictPrompt({ message, onConfirm, onDismiss }: { message: SessionSyncMessage | null; onConfirm: () => void; onDismiss: () => void }) {
  if (!message) return null;
  const copy = message.name === 'WALLET_DISCONNECTED' ? 'Another tab disconnected the wallet.' : message.name === 'NETWORK_CHANGED' ? 'Another tab changed the active network.' : 'Another tab changed the active theme.';
  return <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"><div className="w-full max-w-sm rounded-xl bg-white p-6 text-gray-900 shadow-xl"><h2 className="text-lg font-semibold">Session changed</h2><p className="mt-2 text-sm text-gray-600">{copy} Refresh this tab to align its session state before continuing.</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onDismiss} className="rounded border px-3 py-2 text-sm">Keep this tab</button><button type="button" onClick={onConfirm} className="rounded bg-black px-3 py-2 text-sm text-white">Align session</button></div></div></div>;
}
