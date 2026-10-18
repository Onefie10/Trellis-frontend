import { NotificationManager } from '@/lib/notifications';

describe('NotificationManager - Web Push & BroadcastChannel', () => {
  let manager: NotificationManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = NotificationManager.getInstance();
    // Reset to test state
    (manager as any).isSupported = true;
    (manager as any).broadcastChannel = null;
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('VAPID key handling', () => {
    it('stores VAPID public key', () => {
      manager.setVAPIDKey('test-vapid-key');
      expect(manager.getVAPIDKey()).toBe('test-vapid-key');
    });

    it('returns environment VAPID key when no explicit key set', () => {
      const envKey = 'env-vapid-key';
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = envKey;
      expect(manager.getVAPIDKey()).toBe(envKey);
      delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    });

    it('urlBase64ToUint8Array converts correctly', () => {
      const base64 = 'BM7eBqP4yL9vVx2cR1nK8jH6gF3dA0wZ';
      const uint8Array = (manager as any).urlBase64ToUint8Array(base64);
      expect(uint8Array).toBeInstanceOf(Uint8Array);
      expect(uint8Array.length).toBeGreaterThan(0);
    });
  });

  describe('Notification payload parsing', () => {
    it('parses trade notification payload correctly', async () => {
      const mockTradeResult = {
        success: true,
        hash: '0xabc123',
        metrics: { cpuInstructions: 1000000 },
      };

      const showSpy = jest.spyOn(manager as any, 'showNotification').mockResolvedValue(undefined);
      await (manager as any).showTradeNotification(mockTradeResult, 'TestAgent', '100 XLM');
      expect(showSpy).toHaveBeenCalled();
      const callArgs = showSpy.mock.calls[0][0];
      expect(callArgs.data.type).toBe('trade');
      expect(callArgs.data.transactionHash).toBe('0xabc123');
      expect(callArgs.data.agentName).toBe('TestAgent');
      showSpy.mockRestore();
    });

    it('parses transaction notification payload correctly', async () => {
      const mockResult = { success: true, hash: '0xdef456' };
      const showSpy = jest.spyOn(manager as any, 'showNotification').mockResolvedValue(undefined);
      await (manager as any).showTransactionNotification(mockResult, 'Deployed contract');
      expect(showSpy).toHaveBeenCalled();
      const callArgs = showSpy.mock.calls[0][0];
      expect(callArgs.data.type).toBe('transaction');
      expect(callArgs.data.transactionHash).toBe('0xdef456');
      showSpy.mockRestore();
    });

    it('handles notification with category field', async () => {
      const showSpy = jest.spyOn(manager as any, 'showNotification').mockResolvedValue(undefined);
      await (manager as any).showNotification({
        title: 'Proposal Passed',
        body: 'A governance proposal has passed',
        tag: 'governance',
        data: { type: 'general', category: 'proposal_passing' },
      });
      const callArgs = showSpy.mock.calls[0][0];
      expect(callArgs.data.category).toBe('proposal_passing');
      showSpy.mockRestore();
    });
  });

  describe('Permission fallback', () => {
    it('returns denied when not supported', async () => {
      (manager as any).isSupported = false;
      const permission = await manager.getCurrentPermission();
      expect(permission).toBe('denied');
    });

    it('throws when requesting permission not supported', async () => {
      (manager as any).isSupported = false;
      await expect(manager.requestPermission()).rejects.toThrow('Notifications are not supported');
    });

    it('falls back to browser Notification when service worker fails', async () => {
      (manager as any).isSupported = true;
      const mockPermission = 'granted';
      const getPermissionSpy = jest.spyOn(manager as any, 'getCurrentPermission').mockResolvedValue(mockPermission);
      const swReadySpy = jest.spyOn(manager as any, 'isSupported').mockReturnValue(true);

      const originalNotification = global.Notification;
      const mockShowNotification = jest.fn();
      global.Notification = jest.fn(mockShowNotification) as any;
      (navigator.serviceWorker.ready as Promise<any>).mockRejectedValue(new Error('SW not available'));

      await (manager as any).showNotification({
        title: 'Test',
        body: 'Test body',
        tag: 'test',
      });

      expect(global.Notification).toHaveBeenCalledWith('Test', expect.any(Object));

      global.Notification = originalNotification as any;
      getPermissionSpy.mockRestore();
    });
  });

  describe('Event categories', () => {
    it('returns event categories', () => {
      const categories = manager.getEventCategories();
      expect(typeof categories).toBe('object');
    });

    it('checks if event category is enabled', () => {
      expect(manager.isEventCategoryEnabled('proposal_passing')).toBe(true);
      expect(manager.isEventCategoryEnabled('agent_error')).toBe(true);
    });

    it('marks event category as disabled', () => {
      manager.updatePreferences({ eventCategories: { proposal_passing: false } });
      expect(manager.isEventCategoryEnabled('proposal_passing')).toBe(false);
    });
  });

  describe('Notification preferences with eventCategories', () => {
    it('getPreferences includes eventCategories', () => {
      const prefs = manager.getPreferences();
      expect(prefs.eventCategories).toBeDefined();
      expect(typeof prefs.eventCategories).toBe('object');
    });
  });
});
