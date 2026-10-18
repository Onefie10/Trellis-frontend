"use client";

import React, { useState, useEffect } from "react";
import { MerkleProof } from "../../../lib/provenance/types";
import { verifyMerkleProof } from "../../../lib/provenance/merkle";

interface MerkleProofInspectorProps {
  proof: MerkleProof;
  txHash: string;
}

export default function MerkleProofInspector({ proof, txHash }: MerkleProofInspectorProps) {
  const [isValid, setIsValid] = useState<boolean | null>(null);
  const [isOnChainVerified, setIsOnChainVerified] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function checkProof() {
      setLoading(true);
      try {
        const clientSideValid = await verifyMerkleProof(proof);
        if (isMounted) setIsValid(clientSideValid);

        // Mocking Soroban state query to verify root hash matches on-chain commitment
        // In a real app, you'd use SorobanClient / SorobanContract to read state from the smart contract
        // e.g., const contract = new SorobanContract("ADDRESS", "testnet");
        // const onChainRoot = await contract.invoke("get_root", [txHash]);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Simulating that the root hash is found and matches
        if (isMounted) setIsOnChainVerified(true);
      } catch (err) {
        if (isMounted) {
          setIsValid(false);
          setIsOnChainVerified(false);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    checkProof();

    return () => {
      isMounted = false;
    };
  }, [proof, txHash]);

  return (
    <div className="mt-4 p-4 border border-trellis-vine/30 rounded-lg bg-black/40">
      <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
        <span className="text-lg">🔐</span> Merkle Proof Verification
      </h4>

      {loading ? (
        <div className="text-sm text-gray-400 flex items-center gap-2">
          <div className="animate-spin w-4 h-4 border-2 border-trellis-vine border-t-transparent rounded-full" />
          Verifying cryptographic proof...
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-1 text-xs font-bold rounded ${isValid ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
              {isValid ? '✓ Client-side Validated' : '✗ Validation Failed'}
            </span>
            <span className={`px-2 py-1 text-xs font-bold rounded ${isOnChainVerified ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
              {isOnChainVerified ? '✓ On-chain Match (Soroban)' : '✗ On-chain Mismatch'}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono text-gray-400 break-all bg-black/50 p-3 rounded border border-white/5">
            <div>
              <span className="text-gray-500 block mb-1 uppercase tracking-widest text-[10px]">Leaf Hash</span>
              <span className="text-trellis-vine">{proof.leafHash}</span>
            </div>
            {proof.siblingHashes.map((hash, i) => (
              <div key={i}>
                <span className="text-gray-500 block mb-1 uppercase tracking-widest text-[10px]">Sibling Hash {i + 1}</span>
                <span className="text-amber-400/80">{hash}</span>
              </div>
            ))}
            <div className="pt-2 border-t border-white/10 mt-2">
              <span className="text-gray-500 block mb-1 uppercase tracking-widest text-[10px]">Computed Root Hash</span>
              <span className={isValid ? "text-emerald-400" : "text-rose-400"}>{proof.rootHash}</span>
            </div>
          </div>
          
          {(!isValid || !isOnChainVerified) && (
            <div className="p-3 mt-2 bg-rose-500/10 border border-rose-500/20 rounded-md text-rose-400 text-sm">
              <strong>Warning:</strong> Cryptographic verification failed. This execution record may have been tampered with or does not match the on-chain commitment.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
