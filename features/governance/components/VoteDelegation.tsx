import React, { useState } from 'react';
import { useStellarWallet } from '@/components/context/StellarWalletProvider';

interface VoteDelegationProps {
  onDelegate: (delegateAddress: string) => Promise<void>;
}

export function VoteDelegation({ onDelegate }: VoteDelegationProps) {
  const { wallet } = useStellarWallet();
  const [delegateAddress, setDelegateAddress] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!delegateAddress) return;
    
    setIsSubmitting(true);
    setMessage('');
    try {
      await onDelegate(delegateAddress);
      setMessage('Successfully delegated voting power!');
      setDelegateAddress('');
    } catch (error: any) {
      setMessage(`Error: ${error.message || 'Failed to delegate'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!wallet) {
    return (
      <div className="p-4 rounded-lg border border-trellis-vine/40 nebula-bg">
        <h2 className="text-lg font-semibold glow-text mb-2">Vote Delegation</h2>
        <p className="text-sm text-gray-400">Please connect your wallet to delegate your voting power.</p>
      </div>
    );
  }

  return (
    <div className="p-4 rounded-lg border border-trellis-vine/40 nebula-bg">
      <h2 className="text-lg font-semibold glow-text mb-2">Vote Delegation</h2>
      <p className="text-sm text-gray-400 mb-4">
        Delegate your voting power to a trusted address. They will be able to vote on your behalf in governance proposals.
      </p>
      
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          placeholder="Stellar Address (G...)"
          className="flex-1 px-3 py-2 bg-black/40 border border-white/10 rounded-md text-sm text-white focus:outline-none focus:border-trellis-vine/50"
          value={delegateAddress}
          onChange={(e) => setDelegateAddress(e.target.value)}
          disabled={isSubmitting}
        />
        <button
          type="submit"
          disabled={isSubmitting || !delegateAddress}
          className="px-4 py-2 bg-gradient-to-r from-trellis-vine to-trellis-leaf text-white font-semibold rounded-md hover:shadow-lg disabled:opacity-50 transition-smooth"
        >
          {isSubmitting ? 'Delegating...' : 'Delegate'}
        </button>
      </form>
      
      {message && (
        <p className={`mt-2 text-xs ${message.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400'}`}>
          {message}
        </p>
      )}
    </div>
  );
}
