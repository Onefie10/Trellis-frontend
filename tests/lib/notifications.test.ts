import { groupNotificationsIntoThreads } from '@/lib/notifications';
import { LifecycleNotification } from '@/lib/notifications/lifecycle-types';

describe('Notification Grouping', () => {
  const createMockNotification = (id: string, type: string, dedupKey: string, severity: 'critical'|'warning'|'info'|'success', isRead: boolean, createdAt: string): any => ({
    id,
    type,
    dedupKey,
    severity,
    isRead,
    createdAt,
    title: `Notification ${id}`,
    message: `Message ${id}`,
    dismissed: false,
    audience: 'user',
  });

  it('should group notifications with the same type and dedupKey', () => {
    const notifications = [
      createMockNotification('1', 'agent_minted', 'agent-1', 'info', false, '2023-01-01T10:00:00Z'),
      createMockNotification('2', 'agent_minted', 'agent-1', 'info', false, '2023-01-01T10:05:00Z'),
      createMockNotification('3', 'agent_minted', 'agent-1', 'info', false, '2023-01-01T10:10:00Z'),
    ];

    const result = groupNotificationsIntoThreads(notifications);
    expect(result).toHaveLength(1);
    expect((result[0] as any).isThread).toBe(true);
    expect((result[0] as any).notifications).toHaveLength(3);
    expect((result[0] as any).title).toBe('3 Agent Minted');
  });

  it('should not group notifications with different type or dedupKey', () => {
    const notifications = [
      createMockNotification('1', 'agent_minted', 'agent-1', 'info', false, '2023-01-01T10:00:00Z'),
      createMockNotification('2', 'agent_upgraded', 'agent-1', 'info', false, '2023-01-01T10:05:00Z'),
      createMockNotification('3', 'agent_minted', 'agent-2', 'info', false, '2023-01-01T10:10:00Z'),
    ];

    const result = groupNotificationsIntoThreads(notifications);
    expect(result).toHaveLength(3);
    result.forEach((item: any) => {
      expect(item.isThread).toBeUndefined();
    });
  });

  it('should deduplicate identical notifications before grouping', () => {
    const notifications = [
      createMockNotification('1', 'agent_minted', 'agent-1', 'info', false, '2023-01-01T10:00:00Z'),
      // Same id/content delivered twice — a rapid burst often re-delivers.
      createMockNotification('2', 'agent_minted', 'agent-1', 'info', false, '2023-01-01T10:05:00Z'),
      createMockNotification('2', 'agent_minted', 'agent-1', 'info', false, '2023-01-01T10:05:00Z'),
    ];

    const result = groupNotificationsIntoThreads(notifications);
    expect(result).toHaveLength(1);
    expect((result[0] as any).isThread).toBe(true);
    expect((result[0] as any).notifications).toHaveLength(2);
  });

  it('should keep distinct notifications with the same id but different content', () => {
    const first = createMockNotification('1', 'agent_minted', 'agent-1', 'info', false, '2023-01-01T10:00:00Z');
    const second = createMockNotification('1', 'agent_minted', 'agent-1', 'warning', false, '2023-01-01T10:05:00Z');

    const result = groupNotificationsIntoThreads([first, second]);
    expect(result).toHaveLength(1);
    expect((result[0] as any).notifications).toHaveLength(2);
  });

  it('should take the highest severity for the thread', () => {
    const notifications = [
      createMockNotification('1', 'rate_limit_warning', 'api', 'info', false, '2023-01-01T10:00:00Z'),
      createMockNotification('2', 'rate_limit_warning', 'api', 'warning', false, '2023-01-01T10:05:00Z'),
      createMockNotification('3', 'rate_limit_warning', 'api', 'critical', false, '2023-01-01T10:10:00Z'),
    ];

    const result = groupNotificationsIntoThreads(notifications);
    expect(result).toHaveLength(1);
    expect((result[0] as any).severity).toBe('critical');
  });

  it('should set thread isRead to true only if all notifications are read', () => {
    const notifications1 = [
      createMockNotification('1', 'rate_limit_warning', 'api', 'info', true, '2023-01-01T10:00:00Z'),
      createMockNotification('2', 'rate_limit_warning', 'api', 'info', true, '2023-01-01T10:05:00Z'),
    ];

    const result1 = groupNotificationsIntoThreads(notifications1);
    expect((result1[0] as any).isRead).toBe(true);

    const notifications2 = [
      createMockNotification('1', 'rate_limit_warning', 'api', 'info', true, '2023-01-01T10:00:00Z'),
      createMockNotification('2', 'rate_limit_warning', 'api', 'info', false, '2023-01-01T10:05:00Z'),
    ];

    const result2 = groupNotificationsIntoThreads(notifications2);
    expect((result2[0] as any).isRead).toBe(false);
  });
});
