import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitWhileConnected, DeliveryQueue, deliveryId, notificationStorageKey } from './logic';

describe('notification boundary', () => {
  it('accepts only an opaque delivery id, never a push-supplied URL', () => {
    expect(deliveryId({ deliveryId: 'abc_123-def', url: 'https://evil.test' })).toBe('abc_123-def');
    for (const value of [null, 'abc', { url: 'companybot://chat/123' }, { deliveryId: '../chat' }, { deliveryId: '' }, { deliveryId: 'x'.repeat(129) }, { deliveryId: 7 }]) expect(deliveryId(value)).toBeNull();
  });
  it('does not reopen the initial response when the listener replays it', () => {
    const queue = new DeliveryQueue();
    expect(queue.accept('first')).toBe(true);
    expect(queue.accept('first')).toBe(false);
    expect(queue.accept('second')).toBe(true);
    expect(queue.accept('first')).toBe(false);
  });
  it('isolates deployment and account consent with SecureStore-safe keys', () => {
    const first = notificationStorageKey('https://example.convex.cloud', 'user/a');
    expect(first).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(first).not.toBe(notificationStorageKey('https://example.convex.cloud', 'user_a'));
    expect(first).not.toBe(notificationStorageKey('https://other.convex.cloud', 'user/a'));
    expect(first).not.toBe(notificationStorageKey('https://example.convex.cloud'));
  });
});

describe('signout cleanup', () => {
  afterEach(() => vi.useRealTimers());
  it('waits for an online unregister to complete', async () => {
    expect(await awaitWhileConnected(Promise.resolve(), () => true)).toBe(true);
  });
  it('stops waiting for a queued mutation when the connection drops', async () => {
    vi.useFakeTimers();
    let online = true;
    const waiting = awaitWhileConnected(new Promise(() => {}), () => online);
    online = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(await waiting).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports cleanup failure instead of silently skipping online unregister', async () => {
    await expect(awaitWhileConnected(Promise.reject(new Error('Denied')), () => true)).rejects.toThrow('Denied');
  });
});
