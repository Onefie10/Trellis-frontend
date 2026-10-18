import {
  parseMarketplaceUrlState,
  serializeMarketplaceUrlState,
} from '../useMarketplaceUrlState';

describe('marketplace URL state', () => {
  it('serializes compact category lists and omits default values', () => {
    const serialized = serializeMarketplaceUrlState({
      query: '  risk analysis  ',
      categories: ['audit', 'ai', 'audit'],
      sort: 'top',
    });

    expect(serialized).toBe('q=risk+analysis&cat=ai,audit&sort=top');
  });

  it('restores query, categories, and sort from the URL', () => {
    expect(parseMarketplaceUrlState(new URLSearchParams('q=security&cat=ai,audit&sort=rating'))).toEqual({
      query: 'security',
      categories: ['ai', 'audit'],
      sort: 'rating',
    });
  });

  it('ignores invalid sort values and preserves parameters owned elsewhere', () => {
    const restored = parseMarketplaceUrlState(new URLSearchParams('sort=unknown'));
    expect(restored.sort).toBe('top');

    const serialized = serializeMarketplaceUrlState(
      { query: '', categories: [], sort: 'top' },
      '?campaign=spring&cat=old',
    );
    expect(serialized).toBe('campaign=spring&sort=top');
  });
});
