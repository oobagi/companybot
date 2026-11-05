import { afterEach, describe, expect, it, vi } from 'vitest';
import { injectJavaScriptSafely } from 'expo/src/dom/injectJavaScript';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('native document bridge teardown', () => {
  const removed = new Error("Call to function 'DomWebView.injectJavaScript' has been rejected.\n→ Caused by: Unable to find the class expo.modules.webview.DomWebView view with tag 1960");

  it('handles a native result that rejects after its view detaches', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    let detached = false;
    let reject!: (error: Error) => void;
    injectJavaScriptSafely({ injectJavaScript: () => new Promise((_, fail) => { reject = fail; }) }, 'result', () => detached);
    detached = true;
    reject(removed);
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();
  });

  it('allows React cleanup to follow native view removal in the same event-loop turn', async () => {
    vi.useFakeTimers();
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    let detached = false;
    injectJavaScriptSafely({ injectJavaScript: () => Promise.reject(removed) }, 'result', () => detached);
    await Promise.resolve();
    detached = true;
    await vi.runAllTimersAsync();
    expect(report).not.toHaveBeenCalled();
  });

  it('reports missing-view failures while the view is still attached', async () => {
    vi.useFakeTimers();
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    injectJavaScriptSafely({ injectJavaScript: () => Promise.reject(removed) }, 'result', () => false);
    await vi.runAllTimersAsync();
    expect(report).toHaveBeenCalledWith(removed);
  });

  it.each([true, false])('reports unrelated native failures even after detach (synchronous: %s)', async synchronous => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('JavaScript evaluation failed');
    injectJavaScriptSafely({ injectJavaScript: () => { if (synchronous) throw failure; return Promise.reject(failure); } }, 'result', () => true);
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith(failure);
  });

  it('accepts both void and promise-based WebView implementations', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sync = vi.fn();
    const async = vi.fn(async () => {});
    injectJavaScriptSafely({ injectJavaScript: sync }, 'props', () => false);
    injectJavaScriptSafely({ injectJavaScript: async }, 'props', () => false);
    await Promise.resolve();
    expect(sync).toHaveBeenCalledWith('props');
    expect(async).toHaveBeenCalledWith('props');
    expect(report).not.toHaveBeenCalled();
  });
});
