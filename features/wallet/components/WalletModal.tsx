"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { getAllAdapters, getAdapter, isAdapterAvailable, type StellarWalletAdapter } from "@/lib/wallet/StellarWalletAdapter";
import { useStellarWallet } from "@/components/context/StellarWalletProvider";
import useFocusTrap from "@/components/useFocusTrap";

export function WalletModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const { connectWallet, network } = useStellarWallet();
  const router = useRouter();

  const adapters = getAllAdapters();

  const handleConnect = async (adapter: StellarWalletAdapter) => {
    setConnecting(adapter.type);
    try {
      const available = await isAdapterAvailable(adapter.type);
      if (!available) {
        throw new Error(`${adapter.name} wallet not found`);
      }
      const publicKey = await adapter.connect();
      await connectWallet(adapter.type as any);
      setIsOpen(false);
    } catch (err: any) {
      console.error(`Failed to connect ${adapter.name}:`, err);
    } finally {
      setConnecting(null);
    }
  };

  const trapRef = useFocusTrap<HTMLDivElement>({
    active: isOpen,
    onEscape: () => setIsOpen(false),
  });

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="px-3 py-1.5 bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg text-xs hover:bg-trellis-vine/20 transition-smooth"
      >
        Connect Wallet
      </button>

      {isOpen && (
        <div
          ref={trapRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="select-wallet-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        >
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 id="select-wallet-title" className="text-xl font-bold text-white">Select Wallet</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="text-neutral-400 hover:text-white text-xl"
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              {adapters.map((adapter) => (
                <button
                  key={adapter.type}
                  onClick={() => handleConnect(adapter)}
                  disabled={connecting !== null}
                  className="w-full flex items-center gap-4 p-4 rounded-lg border border-neutral-700 bg-neutral-800/50 hover:border-trellis-vine/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="text-2xl">{adapter.icon}</span>
                  <div className="text-left">
                    <p className="text-white font-medium">{adapter.name}</p>
                    <p className="text-xs text-neutral-400">
                      {connecting === adapter.type ? "Connecting..." : "Connect with {adapter.name}"}
                    </p>
                  </div>
                  {connecting === adapter.type && (
                    <div className="ml-auto animate-spin rounded-full h-5 w-5 border-2 border-trellis-vine border-t-transparent" />
                  )}
                </button>
              ))}
            </div>

            <p className="text-xs text-neutral-500 mt-4 text-center">
              Make sure you have the wallet extension installed
            </p>
          </div>
        </div>
      )}
    </>
  );
}
