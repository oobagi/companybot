import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { addEventListener, getLinkingURL } from 'expo-linking';
import { router, useRootNavigationState, type Href } from 'expo-router';
import { useConvexAuth } from 'convex/react';
import { sessionLink } from './sessionLink';

const PendingLink = createContext<() => string | null>(() => null);

/** Survives the protected navigator's redirect to sign-in, but never survives sign-out. */
export function SessionLinks({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const authenticated = useRef(isAuthenticated);
  const native = Platform.OS === 'ios' || Platform.OS === 'android';
  // SDK 58 supplies this synchronously. An asynchronous launch lookup could
  // overwrite a newer link received while the user was entering their email.
  const [initial] = useState(() => native && !isAuthenticated ? sessionLink(getLinkingURL()) : null);
  const pending = useRef(initial);
  useLayoutEffect(() => {
    if (authenticated.current && !isAuthenticated) pending.current = null;
    authenticated.current = isAuthenticated;
  }, [isAuthenticated, pending]);
  useEffect(() => {
    if (!native) return;
    const subscription = addEventListener('url', ({ url }) => {
      // Signed-in links already belong to Expo Router. Do not navigate twice.
      if (!authenticated.current) pending.current = sessionLink(url);
    });
    return () => subscription.remove();
  }, [native, pending]);
  const take = useCallback(() => {
    if (!authenticated.current) return null;
    const path = pending.current;
    pending.current = null;
    return path;
  }, [pending]);
  return <PendingLink.Provider value={take}>{children}</PendingLink.Provider>;
}

/** Mount only inside the authenticated, hydrated WorkspaceProvider. */
export function SessionLinkNavigation() {
  const take = useContext(PendingLink);
  const state = useRootNavigationState();
  useEffect(() => {
    if (!state?.key) return;
    const destination = take();
    if (destination) router.replace(destination as Href);
  }, [state?.key, take]);
  return null;
}
