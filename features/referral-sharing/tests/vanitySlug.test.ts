import { ReferralService } from '../services/referralService';

// Mock the API client
jest.mock('../../../lib/api', () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    postIdempotent: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));

const { apiClient } = require('../../../lib/api');

describe('ReferralService vanity slugs (issue #128)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes case, spaces, underscores and repeated hyphens', () => {
    expect(ReferralService.normalizeVanitySlug('  Alice Agent  ')).toBe('alice-agent');
    expect(ReferralService.normalizeVanitySlug('alice_agent')).toBe('alice-agent');
    expect(ReferralService.normalizeVanitySlug('a---b--c')).toBe('a-b-c');
  });

  it('accepts a well-formed slug and rejects reserved words', () => {
    expect(ReferralService.validateVanitySlug('alice-agent').valid).toBe(true);
    expect(ReferralService.validateVanitySlug('admin').reason).toBe('RESERVED');
    expect(ReferralService.validateVanitySlug('dashboard').reason).toBe('RESERVED');
  });

  it('enforces the allowed length and charset', () => {
    expect(ReferralService.validateVanitySlug('ab').reason).toBe('TOO_SHORT');
    expect(ReferralService.validateVanitySlug('a'.repeat(33)).reason).toBe('TOO_LONG');
    expect(ReferralService.validateVanitySlug('alice@agent').reason).toBe('INVALID_CHARACTERS');
    expect(ReferralService.validateVanitySlug('   ').reason).toBe('EMPTY');
  });

  it('detects collisions case-insensitively against existing slugs', () => {
    expect(ReferralService.validateVanitySlug('Alice', ['alice', 'bob']).reason).toBe('COLLISION');
    expect(ReferralService.findVanitySlugCollision('Alice', ['bob', 'ALICE'])).toBe('ALICE');
    expect(ReferralService.validateVanitySlug('carol', ['alice', 'bob']).valid).toBe(true);
    expect(ReferralService.findVanitySlugCollision('carol', ['alice'])).toBeNull();
  });

  it('builds a clean trellis.market/r/<slug> URL', () => {
    expect(ReferralService.buildVanityUrl('Alice-Agent')).toBe(
      'https://trellis.market/r/alice-agent',
    );
    expect(ReferralService.buildVanityUrl('alice')).toBe('https://trellis.market/r/alice');
  });

  it('registers a valid alias through the backend and returns the vanity URL', async () => {
    apiClient.post.mockResolvedValue({
      id: 'ref_1',
      code: 'ASTRABCD1234',
      userId: 'user123',
      createdAt: '2026-09-27T00:00:00Z',
      isActive: true,
      uses: 0,
      reward: '10 XLM',
      url: 'https://legacy.example/ref/ASTRABCD1234',
    });

    const link = await ReferralService.registerVanitySlug({
      userId: 'user123',
      slug: 'Alice Agent',
      targetAgentId: 'agent-42',
    });

    expect(apiClient.post).toHaveBeenCalledWith('/api/affiliates/vanity-slugs', {
      walletAddress: 'user123',
      slug: 'alice-agent',
      targetAgentId: 'agent-42',
      url: 'https://trellis.market/r/alice-agent',
      reward: '10 XLM',
    });
    expect(link.slug).toBe('alice-agent');
    expect(link.targetAgentId).toBe('agent-42');
    expect(link.url).toBe('https://trellis.market/r/alice-agent');
  });

  it('refuses an invalid or taken alias without calling the backend', async () => {
    await expect(
      ReferralService.registerVanitySlug({
        userId: 'user123',
        slug: 'admin',
        targetAgentId: 'agent-42',
      }),
    ).rejects.toMatchObject({ reason: 'RESERVED' });

    await expect(
      ReferralService.registerVanitySlug({
        userId: 'user123',
        slug: 'alice',
        targetAgentId: 'agent-42',
        existingSlugs: ['ALICE'],
      }),
    ).rejects.toMatchObject({ reason: 'COLLISION' });

    await expect(
      ReferralService.registerVanitySlug({
        userId: 'user123',
        slug: 'alice',
        targetAgentId: '   ',
      }),
    ).rejects.toMatchObject({ reason: 'AGENT_REQUIRED' });

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('asks the backend about availability but rejects invalid slugs up front', async () => {
    apiClient.get.mockResolvedValue({ available: false });
    await expect(ReferralService.isVanitySlugAvailable('alice')).resolves.toBe(false);
    expect(apiClient.get).toHaveBeenCalledWith('/api/affiliates/vanity-slugs?slug=alice');

    apiClient.get.mockClear();
    await expect(ReferralService.isVanitySlugAvailable('admin')).resolves.toBe(false);
    expect(apiClient.get).not.toHaveBeenCalled();

    apiClient.get.mockRejectedValue(new Error('offline'));
    await expect(ReferralService.isVanitySlugAvailable('carol')).resolves.toBe(true);
  });
});
