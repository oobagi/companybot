import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@companybot/backend/convex/_generated/api';
import { createSyncTransport } from './transport';

function fixture() {
  const callbacks = {
    getSteps: vi.fn(async () => ({ steps: ['step'], clientIds: ['client'], version: 2 })),
    submitSteps: vi.fn(async () => ({ status: 'synced' as const })),
  };
  return { callbacks, transport: createSyncTransport('page-a', callbacks, 1) };
}

describe('document bridge capabilities', () => {
  it('rejects another document and unrelated backend functions before calling native code', async () => {
    const { callbacks, transport } = fixture();
    await expect(transport.client.query(api.pageSync.getSteps, { id: 'page-b' as Id<'pages'>, version: 1 })).rejects.toThrow('another document');
    await expect(transport.client.query(api.pageSync.getSnapshot, { id: 'page-a' as Id<'pages'> })).rejects.toThrow('Unsupported');
    await expect(transport.client.mutation(api.pageSync.submitSteps, { id: 'page-b' as Id<'pages'>, version: 1, clientId: 'x', steps: [] })).rejects.toThrow('another document');
    expect(callbacks.getSteps).not.toHaveBeenCalled();
    expect(callbacks.submitSteps).not.toHaveBeenCalled();
  });
  it('forwards collaboration steps without giving the DOM control of the page scope', async () => {
    const { callbacks, transport } = fixture();
    expect(await transport.client.query(api.pageSync.getSteps, { id: 'page-a' as Id<'pages'>, version: 1 })).toEqual({ steps: ['step'], clientIds: ['client'], version: 2 });
    await transport.client.mutation(api.pageSync.submitSteps, { id: 'page-a' as Id<'pages'>, version: 1, clientId: 'x', steps: ['s'] });
    expect(callbacks.submitSteps).toHaveBeenCalledWith({ version: 1, clientId: 'x', steps: ['s'] });
    await transport.client.mutation(api.pageSync.submitSnapshot, { id: 'page-a' as Id<'pages'>, version: 99, content: 'untrusted' });
    expect(callbacks.submitSteps).toHaveBeenCalledTimes(1);
  });
  it('delivers version updates to each live editor and respects unsubscribe', () => {
    const { transport } = fixture();
    const watch = transport.client.watchQuery(api.pageSync.latestVersion, { id: 'page-a' as Id<'pages'> });
    const first = vi.fn(); const second = vi.fn();
    const off = watch.onUpdate(first); watch.onUpdate(second);
    transport.update(3);
    expect(watch.localQueryResult()).toBe(3);
    off(); transport.update(4);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(2);
    expect(() => transport.client.watchQuery(api.pageSync.latestVersion, { id: 'page-b' as Id<'pages'> })).toThrow('another document');
  });
  it('uses replacement native callbacks after permissions or component state changes', async () => {
    const { callbacks, transport } = fixture();
    transport.replaceCallbacks({ ...callbacks, submitSteps: async () => { throw new Error('Read only'); } });
    await expect(transport.client.mutation(api.pageSync.submitSteps, { id: 'page-a' as Id<'pages'>, version: 1, clientId: 'x', steps: [] })).rejects.toThrow('Read only');
    expect(callbacks.submitSteps).not.toHaveBeenCalled();
  });
});
