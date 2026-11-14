/** Only replay app destinations, never an external URL or navigation-control parameters. */
export function sessionLink(url: string | null): string | null {
  if (!url || !/^companybot:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.port || parsed.hash) return null;
    const path = ((parsed.hostname ? `/${parsed.hostname}${parsed.pathname}` : parsed.pathname).replace(/\/$/, '') || '/').replace(/^\/page\//, '/pages/');
    const id = '[a-zA-Z0-9_-]+';
    const supported = /^\/(?:pages|databases|settings|saved|workspaces)?$/.test(path)
      || new RegExp(`^/(?:pages|database|record)/${id}$`).test(path)
      || new RegExp(`^/chat/${id}(?:/details|/thread/${id})?$`).test(path)
      || /^\/settings\/(?:general|preferences|members|permissions|agents|skills|automations|connectors|memory|activity|usage|archive)$/.test(path);
    if (!supported) return null;
    const query = new URLSearchParams();
    for (const name of ['messageId', 'itemId', 'connectorId']) {
      const value = parsed.searchParams.get(name);
      if (value && /^[a-zA-Z0-9_-]+$/.test(value)) query.set(name, value);
    }
    return `${path}${query.size ? `?${query}` : ''}`;
  } catch { return null; }
}
