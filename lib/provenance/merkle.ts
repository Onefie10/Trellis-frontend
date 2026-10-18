export interface MerkleProof {
  leafHash: string;
  siblingHashes: string[];
  rootHash: string;
}

export async function sha256(data: string): Promise<string> {
  if (typeof window !== "undefined" && window.crypto && window.crypto.subtle) {
    const encoder = new TextEncoder();
    const buffer = encoder.encode(data);
    const hashBuffer = await window.crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } else {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(data).digest("hex");
  }
}

export async function verifyMerkleProof(proof: MerkleProof): Promise<boolean> {
  let currentHash = proof.leafHash;
  
  for (const siblingHash of proof.siblingHashes) {
    // We sort the two hashes to ensure order independence in verification
    // (a common convention in simple Merkle tree implementations)
    const combined = [currentHash, siblingHash].sort().join("");
    currentHash = await sha256(combined);
  }
  
  return currentHash === proof.rootHash;
}
