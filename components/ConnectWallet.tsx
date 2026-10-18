'use client';

import React, { useCallback, useState } from 'react';
import { useStellarWallet } from './context/StellarWalletProvider';
import Button from './Button';
import LedgerConnectModal from '@/features/wallet/components/LedgerConnectModal';
import { isWebHidSupported } from '@/features/wallet/ledger';

interface ConnectWalletProps {
  className?: string;
}

export default function ConnectWallet({ className = '' }: ConnectWalletProps) {
  const { wallet, isConnecting, error, connectWallet, clearError } = useStellarWallet();
  const [showMenu, setShowMenu] = useState(false);
  const [showLedger, setShowLedger] = useState(false);

  const connected = Boolean(wallet?.isConnected);
  const webHidSupported = isWebHidSupported();

  const handleConnect = async (walletType: 'freighter' | 'albedo' | 'ledger') => {
    clearError();
    try {
      await connectWallet(walletType);
      setShowMenu(false);
    } catch (err) {
      console.error('Connection error:', err);
    }
  };

  const openLedger = () => {
    clearError();
    setShowMenu(false);
    setShowLedger(true);
  };

  // The Ledger dialog already opened the WebHID session and verified the address,
  // so this reuses that session instead of prompting on the device again.
  const handleLedgerConnected = useCallback(async () => {
    await connectWallet('ledger');
    setShowLedger(false);
  }, [connectWallet]);

  return (
    <>
      {!connected && (
        <div className={`relative ${className}`}>
          <div className="relative">
            <Button
              onClick={() => setShowMenu(!showMenu)}
              disabled={isConnecting}
              className="flex items-center gap-2"
            >
              <span>⛓️</span>
              {isConnecting ? 'Connecting...' : 'Connect Wallet'}
            </Button>

            {showMenu && (
              <div className="absolute end-0 mt-2 w-48 bg-gray-900 border border-cyan-500/30 rounded-lg shadow-lg z-50">
                <div className="p-2">
                  <button
                    onClick={() => handleConnect('freighter')}
                    disabled={isConnecting}
                    className="w-full text-start px-4 py-2 hover:bg-gray-800 rounded transition-colors flex items-center gap-2"
                  >
                    <span>🔐</span>
                    Freighter
                  </button>
                  <button
                    onClick={() => handleConnect('albedo')}
                    disabled={isConnecting}
                    className="w-full text-start px-4 py-2 hover:bg-gray-800 rounded transition-colors flex items-center gap-2"
                  >
                    <span>🌟</span>
                    Albedo
                  </button>
                  <button
                    onClick={openLedger}
                    disabled={isConnecting}
                    title={
                      webHidSupported
                        ? 'Sign with a Ledger device over WebHID'
                        : 'WebHID is not available in this browser'
                    }
                    className="w-full text-start px-4 py-2 hover:bg-gray-800 rounded transition-colors flex items-center gap-2"
                  >
                    <span>💳</span>
                    Ledger
                  </button>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="absolute top-full mt-2 p-2 bg-red-900/20 border border-red-500/50 rounded text-red-300 text-sm w-64">
              {error}
            </div>
          )}
        </div>
      )}

      <LedgerConnectModal
        open={showLedger}
        onClose={() => setShowLedger(false)}
        onConnected={handleLedgerConnected}
      />
    </>
  );
}
