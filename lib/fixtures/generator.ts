import {
  Agent,
  StellarWallet,
  TradingBonus,
  BonusType,
  Portfolio,
  ResourceMetrics,
  SorobanTransactionResult
} from '../types';

export class PRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed ? seed : 123456789;
  }

  nextInt(): number {
    this.state = (1103515245 * this.state + 12345) % 0x80000000;
    return this.state;
  }

  nextFloat(): number {
    return this.nextInt() / (0x80000000 - 1);
  }

  nextRange(min: number, max: number): number {
    return min + Math.floor(this.nextFloat() * (max - min));
  }

  choice<T>(array: T[]): T {
    if (array.length === 0) throw new Error('Cannot choose from empty array');
    return array[this.nextRange(0, array.length)];
  }

  randomString(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += this.choice(chars.split(''));
    }
    return result;
  }
}

export type FixtureScenario = 'normal' | 'edge' | 'failure';

export class FixtureGenerator {
  private prng: PRNG;

  constructor(seed: number = 42) {
    this.prng = new PRNG(seed);
  }

  generateAgent(scenario: FixtureScenario = 'normal'): Agent {
    if (scenario === 'failure') {
      return {
        id: '',
        name: '',
        description: '',
        author: '',
        rating: -1,
        users: -100,
        behavior: '',
        capabilities: [],
        status: 'draft',
        createdAt: 'invalid-date',
        updatedAt: 'invalid-date',
      };
    }

    if (scenario === 'edge') {
      return {
        id: this.prng.randomString(255),
        name: this.prng.randomString(255),
        description: this.prng.randomString(10000),
        author: this.prng.randomString(255),
        rating: 0,
        users: 0,
        behavior: '',
        capabilities: Array(100).fill(0).map(() => this.prng.randomString(10)),
        status: 'inactive',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    }

    return {
      id: `agent-${this.prng.nextInt()}`,
      name: `Agent ${this.prng.randomString(5)}`,
      description: 'A standard trading agent',
      author: `author-${this.prng.randomString(5)}`,
      rating: this.prng.nextRange(1, 6),
      users: this.prng.nextRange(10, 10000),
      behavior: 'balanced',
      capabilities: ['trading', 'analysis'],
      status: 'active',
      createdAt: new Date(Date.now() - this.prng.nextRange(0, 100000000)).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  generateStellarWallet(scenario: FixtureScenario = 'normal'): StellarWallet {
    if (scenario === 'failure') {
      return {
        publicKey: 'invalid_key',
        name: '',
        type: 'freighter',
        isConnected: false,
        balances: [],
        network: 'testnet',
      };
    }

    if (scenario === 'edge') {
      return {
        publicKey: `G${this.prng.randomString(55).toUpperCase()}`,
        name: this.prng.randomString(255),
        type: 'ledger',
        isConnected: true,
        balances: Array(1000).fill(0).map(() => ({
          asset: this.prng.randomString(12),
          balance: '0.0000001',
        })),
        network: 'futurenet',
      };
    }

    return {
      publicKey: `G${this.prng.randomString(55).toUpperCase()}`,
      name: `Wallet ${this.prng.nextInt()}`,
      type: this.prng.choice(['freighter', 'albedo']),
      isConnected: true,
      balances: [
        { asset: 'native', balance: `${this.prng.nextRange(10, 10000)}` },
      ],
      network: 'mainnet',
    };
  }

  generateTradingBonus(scenario: FixtureScenario = 'normal'): TradingBonus {
    if (scenario === 'failure') {
      return {
        id: '',
        type: BonusType.REFERRAL,
        amount: '-100',
        asset: '',
        timestamp: 'invalid',
        status: 'pending',
        description: '',
      };
    }

    if (scenario === 'edge') {
      return {
        id: this.prng.randomString(255),
        type: BonusType.QUEST,
        amount: '0.000000000000000001',
        asset: this.prng.randomString(12),
        timestamp: new Date(253402300799999).toISOString(),
        status: 'projected',
        description: this.prng.randomString(1000),
      };
    }

    return {
      id: `bonus-${this.prng.nextInt()}`,
      type: this.prng.choice(Object.values(BonusType)),
      amount: `${this.prng.nextRange(10, 1000)}`,
      asset: 'XLM',
      timestamp: new Date().toISOString(),
      status: this.prng.choice(['earned', 'pending']),
      description: 'Standard bonus',
    };
  }

  generatePortfolio(scenario: FixtureScenario = 'normal'): Portfolio {
    if (scenario === 'failure') {
      return {
        agentId: '',
        performance: NaN,
        interactions: -1,
        lastUpdated: 'invalid',
      };
    }

    if (scenario === 'edge') {
      return {
        agentId: this.prng.randomString(255),
        performance: Number.MAX_VALUE,
        interactions: Number.MAX_SAFE_INTEGER,
        lastUpdated: new Date(0).toISOString(),
      };
    }

    return {
      agentId: `agent-${this.prng.nextInt()}`,
      performance: this.prng.nextFloat() * 100,
      interactions: this.prng.nextRange(0, 1000),
      lastUpdated: new Date().toISOString(),
    };
  }

  generateSorobanTransactionResult(scenario: FixtureScenario = 'normal'): SorobanTransactionResult {
    if (scenario === 'failure') {
      return {
        success: false,
        error: 'Contract execution failed',
      };
    }

    if (scenario === 'edge') {
      return {
        success: true,
        hash: this.prng.randomString(64),
        metrics: {
          cpuInstructions: Number.MAX_SAFE_INTEGER,
          ramBytes: Number.MAX_SAFE_INTEGER,
          ledgerReadBytes: Number.MAX_SAFE_INTEGER,
          ledgerWriteBytes: Number.MAX_SAFE_INTEGER,
          readCount: 10000,
          writeCount: 10000,
          costXlm: '1000000',
        },
        events: Array(100).fill(0).map(() => ({
          type: 'contract',
          contractId: this.prng.randomString(56),
          topics: [this.prng.randomString(32)],
          value: this.prng.randomString(100),
        })),
      };
    }

    return {
      success: true,
      hash: this.prng.randomString(64),
      metrics: {
        cpuInstructions: this.prng.nextRange(1000, 1000000),
        ramBytes: this.prng.nextRange(1024, 1024 * 1024),
        ledgerReadBytes: this.prng.nextRange(100, 10000),
        ledgerWriteBytes: this.prng.nextRange(0, 1000),
        readCount: this.prng.nextRange(1, 10),
        writeCount: this.prng.nextRange(0, 5),
        costXlm: '0.01',
      },
    };
  }
}
