import { SorobanRpcPoolManager } from './client';

describe('SorobanRpcPoolManager', () => {
  it('retries failed requests against fallback RPC nodes', async () => {
    const manager = new SorobanRpcPoolManager('testnet', [
      'https://primary.example/rpc',
      'https://fallback.example/rpc',
    ]);

    const primaryServer = {
      simulateTransaction: jest.fn().mockRejectedValue({ response: { status: 429 } }),
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    };

    const fallbackServer = {
      simulateTransaction: jest.fn().mockResolvedValue({ id: 'ok' }),
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    };

    (manager as any).servers = [primaryServer, fallbackServer];
    (manager as any).activeIndex = 0;

    const result = await manager.executeWithRetry(async (server) => {
      return server.simulateTransaction({});
    });

    expect(primaryServer.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(fallbackServer.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 'ok' });
    expect(manager.getStatus().status).toBe('connected');
  });
});
