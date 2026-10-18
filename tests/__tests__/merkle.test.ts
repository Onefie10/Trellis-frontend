import { sha256, verifyMerkleProof, MerkleProof } from "../../lib/provenance/merkle";

describe("Merkle Tree Verification", () => {
  it("should verify a valid simple merkle proof", async () => {
    const leaf = "leaf-data";
    const leafHash = await sha256(leaf);
    
    const sibling = "sibling-data";
    const siblingHash = await sha256(sibling);
    
    // Compute expected root hash
    const combined = [leafHash, siblingHash].sort().join("");
    const rootHash = await sha256(combined);
    
    const proof: MerkleProof = {
      leafHash,
      siblingHashes: [siblingHash],
      rootHash
    };
    
    const isValid = await verifyMerkleProof(proof);
    expect(isValid).toBe(true);
  });

  it("should fail verification if root hash is tampered", async () => {
    const leafHash = await sha256("leaf-data");
    const siblingHash = await sha256("sibling-data");
    
    const proof: MerkleProof = {
      leafHash,
      siblingHashes: [siblingHash],
      rootHash: "invalid_root_hash"
    };
    
    const isValid = await verifyMerkleProof(proof);
    expect(isValid).toBe(false);
  });

  it("should fail verification if a sibling hash is tampered", async () => {
    const leafHash = await sha256("leaf-data");
    const siblingHash = await sha256("sibling-data");
    
    const combined = [leafHash, siblingHash].sort().join("");
    const rootHash = await sha256(combined);
    
    const proof: MerkleProof = {
      leafHash,
      siblingHashes: ["tampered_sibling_hash"],
      rootHash
    };
    
    const isValid = await verifyMerkleProof(proof);
    expect(isValid).toBe(false);
  });

  it("should fail verification if leaf hash is tampered", async () => {
    const leafHash = await sha256("leaf-data");
    const siblingHash = await sha256("sibling-data");
    
    const combined = [leafHash, siblingHash].sort().join("");
    const rootHash = await sha256(combined);
    
    const proof: MerkleProof = {
      leafHash: "tampered_leaf_hash",
      siblingHashes: [siblingHash],
      rootHash
    };
    
    const isValid = await verifyMerkleProof(proof);
    expect(isValid).toBe(false);
  });

  it("should verify multi-level merkle proof", async () => {
    const leafHash = await sha256("L1");
    const sib1 = await sha256("L2");
    
    let current = [leafHash, sib1].sort().join("");
    const node1 = await sha256(current);
    
    const sib2 = await sha256("Node2");
    current = [node1, sib2].sort().join("");
    const rootHash = await sha256(current);

    const proof: MerkleProof = {
      leafHash,
      siblingHashes: [sib1, sib2],
      rootHash
    };

    const isValid = await verifyMerkleProof(proof);
    expect(isValid).toBe(true);
  });
});
