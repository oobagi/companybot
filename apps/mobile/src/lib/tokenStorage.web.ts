export const tokenStorage = {
  getItem: (key: string) => typeof window === 'undefined' ? null : window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
  removeItem: (key: string) => window.localStorage.removeItem(key),
};
