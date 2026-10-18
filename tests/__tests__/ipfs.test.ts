import { IPFS_GATEWAYS, sha256Hex } from '@/lib/ipfs';
describe('IPFS metadata resilience', () => { it('configures multiple fallback gateways', () => { expect(IPFS_GATEWAYS.length).toBeGreaterThan(1); }); it('produces deterministic SHA-256 hashes', async () => { expect(await sha256Hex('trellis')).toBe('3a4ad37e305ff3bb775fb38a93345aa1f29961fcf88e9415a093d9e6eec8c65a'); }); });
