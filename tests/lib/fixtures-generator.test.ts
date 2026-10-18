import { FixtureGenerator, PRNG } from '../../lib/fixtures/generator';
import { BonusType } from '../../lib/types';

describe('PRNG', () => {
  it('should generate repeatable sequences with the same seed', () => {
    const prng1 = new PRNG(42);
    const prng2 = new PRNG(42);

    expect(prng1.nextInt()).toBe(prng2.nextInt());
    expect(prng1.nextFloat()).toBe(prng2.nextFloat());
    expect(prng1.randomString(10)).toBe(prng2.randomString(10));
  });

  it('should generate different sequences with different seeds', () => {
    const prng1 = new PRNG(42);
    const prng2 = new PRNG(43);

    expect(prng1.nextInt()).not.toBe(prng2.nextInt());
  });
});

describe('FixtureGenerator', () => {
  let generator: FixtureGenerator;

  beforeEach(() => {
    generator = new FixtureGenerator(42);
  });

  describe('generateAgent', () => {
    it('should generate stable normal agent', () => {
      const agent = generator.generateAgent('normal');
      expect(agent).toBeDefined();
      
      const generator2 = new FixtureGenerator(42);
      const agent2 = generator2.generateAgent('normal');
      expect(agent).toEqual(agent2);
    });

    it('should generate edge agent', () => {
      const agent = generator.generateAgent('edge');
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.status).toBe('inactive');
      expect(agent.capabilities.length).toBe(100);
    });

    it('should generate failure agent', () => {
      const agent = generator.generateAgent('failure');
      expect(agent.id).toBe('');
      expect(agent.rating).toBe(-1);
      expect(agent.createdAt).toBe('invalid-date');
    });
  });

  describe('generateStellarWallet', () => {
    it('should generate stable normal wallet', () => {
      const wallet = generator.generateStellarWallet('normal');
      expect(wallet).toBeDefined();
      
      const generator2 = new FixtureGenerator(42);
      const wallet2 = generator2.generateStellarWallet('normal');
      expect(wallet).toEqual(wallet2);
    });

    it('should generate edge wallet', () => {
      const wallet = generator.generateStellarWallet('edge');
      expect(wallet.balances.length).toBe(1000);
      expect(wallet.network).toBe('futurenet');
    });

    it('should generate failure wallet', () => {
      const wallet = generator.generateStellarWallet('failure');
      expect(wallet.publicKey).toBe('invalid_key');
      expect(wallet.isConnected).toBe(false);
    });
  });

  describe('generateTradingBonus', () => {
    it('should generate stable normal trading bonus', () => {
      const bonus = generator.generateTradingBonus('normal');
      
      const generator2 = new FixtureGenerator(42);
      const bonus2 = generator2.generateTradingBonus('normal');
      expect(bonus).toEqual(bonus2);
    });
  });

  describe('generatePortfolio', () => {
    it('should generate stable normal portfolio', () => {
      const portfolio = generator.generatePortfolio('normal');
      
      const generator2 = new FixtureGenerator(42);
      const portfolio2 = generator2.generatePortfolio('normal');
      expect(portfolio).toEqual(portfolio2);
    });
  });

  describe('generateSorobanTransactionResult', () => {
    it('should generate stable normal transaction result', () => {
      const tx = generator.generateSorobanTransactionResult('normal');
      
      const generator2 = new FixtureGenerator(42);
      const tx2 = generator2.generateSorobanTransactionResult('normal');
      expect(tx).toEqual(tx2);
    });
  });
});
