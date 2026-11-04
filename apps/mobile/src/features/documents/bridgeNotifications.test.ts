import { expect, it, vi } from 'vitest';
import { createBridgeNotifications } from './bridgeNotifications';

it('contains native callback rejections and reports errors only to the active editor', async () => {
  const report = vi.fn();
  const notifications = createBridgeNotifications(report);
  const release = notifications.retain();
  const failure = new Error('Native callback failed');
  await expect(notifications.send(async () => { throw failure; })).resolves.toBeUndefined();
  expect(report).toHaveBeenCalledWith(failure);
  report.mockClear();
  let reject!: (error: Error) => void;
  const pending = notifications.send(() => new Promise((_, fail) => { reject = fail; }));
  release(); notifications.retain(); // StrictMode or a remounted DOM generation.
  reject(failure); await expect(pending).resolves.toBeUndefined();
  expect(report).not.toHaveBeenCalled();
});

it('does not invoke native callbacks after cleanup or before the editor mounts', async () => {
  const notifications = createBridgeNotifications(vi.fn());
  const notify = vi.fn(async () => {});
  await notifications.send(notify); expect(notify).not.toHaveBeenCalled();
  const release = notifications.retain(); await notifications.send(notify);
  release(); await notifications.send(notify);
  expect(notify).toHaveBeenCalledOnce();
});
