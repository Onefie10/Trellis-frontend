import { create as ipfsHttpClient, IPFSHTTPClient } from 'ipfs-http-client';
import { NFTStorage, File as NFTFile } from 'nft.storage';
import axios from 'axios';
import { CacheOptions, getOrFetchCachedValue } from './cache-manager';

export interface IPFSUploadResult {
  cid: string;
  url: string;
}

export interface AgentMetadata {
  name: string;
  description: string;
  image: File;
  attributes: Record<string, any>;
}

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
export const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

// Use env or config for these
const NFT_STORAGE_TOKEN = process.env.NEXT_PUBLIC_NFT_STORAGE_TOKEN || '';

export async function uploadToIPFS(
  metadata: AgentMetadata,
  retries = 3
): Promise<IPFSUploadResult> {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const client = new NFTStorage({ token: NFT_STORAGE_TOKEN });
      const imageFile = new NFTFile([metadata.image], metadata.image.name, {
        type: metadata.image.type,
      });
      const data = {
        name: metadata.name,
        description: metadata.description,
        image: imageFile,
        attributes: metadata.attributes,
      };
      const result = await client.store(data as any);
      // NFT.storage returns .ipnft (CID for metadata)
      return {
        cid: result.ipnft,
        url: `${IPFS_GATEWAY}${result.ipnft}`,
      };
    } catch (err) {
      lastError = err;
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface IPFSFetchOptions extends CacheOptions { gateways?: string[]; expectedSha256?: string; signal?: AbortSignal; }

export async function fetchVerifiedIPFSMetadata<T = Record<string, unknown>>(cid: string, options: IPFSFetchOptions = {}): Promise<T> {
  return getOrFetchCachedValue<T>(cid, async () => {
    let lastError: unknown;
    for (const gateway of options.gateways ?? IPFS_GATEWAYS) {
      try {
        const response = await fetch(`${gateway}${encodeURIComponent(cid)}`, { signal: options.signal });
        if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}`);
        const raw = await response.text();
        if (options.expectedSha256 && (await sha256Hex(raw)).toLowerCase() !== options.expectedSha256.toLowerCase()) throw new Error('IPFS metadata hash verification failed');
        return JSON.parse(raw) as T;
      } catch (error) { lastError = error; }
    }
    throw new Error(`Unable to fetch verified IPFS metadata for ${cid}: ${lastError instanceof Error ? lastError.message : 'all gateways failed'}`);
  }, options);
}

// Validate image size (max 2MB)
export function validateImageSize(file: File, maxSizeMB = 2): boolean {
  return file.size <= maxSizeMB * 1024 * 1024;
}

// Validate metadata schema (basic)
export function validateAgentMetadata(meta: Partial<AgentMetadata>): string[] {
  const errors: string[] = [];
  if (!meta.name) errors.push('Name is required');
  if (!meta.description) errors.push('Description is required');
  if (!meta.image) errors.push('Image is required');
  if (meta.image && !validateImageSize(meta.image)) errors.push('Image must be <= 2MB');
  return errors;
}
