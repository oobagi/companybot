/** Pushes carry opaque delivery IDs, never a URL or trusted workspace ID. */
export function deliveryId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('deliveryId' in data)) return null;
  const id = data.deliveryId;
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : null;
}

export function notificationStorageKey(deployment: string, account?: string) {
  // SecureStore accepts only alphanumeric characters, '.', '-', and '_'. Encoding is injective.
  const encode = (value: string) => Array.from(value).map(c => c.codePointAt(0)!.toString(16)).join('-');
  return `notifications.${encode(deployment)}.${account ? `account.${encode(account)}` : 'installation'}`;
}

/** Bounded deduplication also covers the cold-start response replayed by the listener. */
export class DeliveryQueue {
  private seen = new Set<string>();
  accept(id: string) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
}

/** Convex queues offline mutations. Signout must not wait forever behind that queue. */
export function awaitWhileConnected(work: Promise<unknown>, connected: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => { if (!connected()) finish(false); }, 200);
    const timeout = setTimeout(() => finish(undefined, new Error('Notification cleanup timed out. Try signing out again.')), timeoutMs);
    function finish(result?: boolean, error?: unknown) {
      clearInterval(poll); clearTimeout(timeout);
      if (error) reject(error); else resolve(result ?? true);
    }
    work.then(() => finish(true), error => finish(undefined, error));
    if (!connected()) finish(false);
  });
}
