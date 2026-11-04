import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { useConvex, useConvexAuth } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api, errorMessage } from '@/lib/api';
import { convexUrl } from '@/lib/config';
import { useQuery } from '@/lib/convex';
import { awaitWhileConnected, DeliveryQueue, deliveryId, notificationStorageKey } from './logic';

const native = Platform.OS === 'ios' || Platform.OS === 'android';
const projectId: string | undefined = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
const setup = !native ? 'Push notifications are available in the iOS and Android app.'
  : Constants.executionEnvironment === ExecutionEnvironment.StoreClient ? 'Push notifications require a development or production build. Open the installed Companybot app instead of Expo Go.'
  : !projectId ? 'Notifications are not enabled for this build yet.' : null;
const allowed = (permission: Notifications.NotificationPermissionsStatus) => permission.granted || permission.ios?.status === IosAuthorizationStatus.PROVISIONAL;
const installationKey = notificationStorageKey(convexUrl ?? '');
let installationPromise: Promise<string> | undefined;
function installationId() {
  return installationPromise ??= SecureStore.getItemAsync(installationKey).then(async existing => {
    if (existing) return existing;
    const id = Crypto.randomUUID();
    await SecureStore.setItemAsync(installationKey, id);
    return id;
  }).catch(error => { installationPromise = undefined; throw error; });
}

type Destination = NonNullable<FunctionReturnType<typeof api.mobileNotifications.resolve>>;
type Pending = { deliveryId: string; destination?: Destination; approved?: boolean };
type ContextValue = {
  setup: string | null; ready: boolean; requested: boolean; enabled: boolean; busy: boolean; denied: boolean; error?: string;
  enable: () => Promise<void>; disable: () => Promise<void>; beforeSignOut: () => Promise<void>;
  pending: Pending | null; resolvePending: () => Promise<Destination | null>; approvePending: (id: string, destination: Destination) => void;
  finishPending: (id: string) => void; reportError: (error: unknown) => void;
};
const Context = createContext<ContextValue | null>(null);
export function useNotifications() {
  const value = useContext(Context);
  if (!value) throw new Error('NotificationsProvider is missing.');
  return value;
}

/** Mount once under Convex auth, outside the workspace-keyed subtree. Never prompts on mount. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(api.workspace.me, isAuthenticated ? {} : 'skip');
  const userId = isAuthenticated ? me?.userId : undefined;
  const accountKey = userId ? notificationStorageKey(convexUrl ?? '', userId) : null;
  const [installation, setInstallation] = useState<string>();
  const [intent, setIntent] = useState<{ key: string; enabled: boolean }>();
  const [permission, setPermission] = useState<Notifications.NotificationPermissionsStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef(pending);
  const accountRef = useRef(accountKey);
  useLayoutEffect(() => { pendingRef.current = pending; accountRef.current = accountKey; }, [pending, accountKey]);
  const previousAccount = useRef(accountKey);
  const suspended = useRef(false);
  const operation = useRef<{ key: string | null; promise: Promise<void> } | null>(null);
  const queue = useRef(new DeliveryQueue());
  const optedIn = !!accountKey && intent?.key === accountKey && intent.enabled;
  const status = useQuery(api.mobileNotifications.status, userId && installation ? { installationId: installation } : 'skip');
  const badge = useQuery(api.mobileNotifications.badge, userId && optedIn ? {} : 'skip');
  const reportError = useCallback((e: unknown) => setError(errorMessage(e)), []);

  useEffect(() => {
    // A signed-out cold-start tap can wait for login; a tap from a previous account cannot.
    if (previousAccount.current && previousAccount.current !== accountKey) {
      // External auth transitions invalidate pending native notification state.
      setPending(null);
      operation.current = null;
      setBusy(false);
      setError(undefined);
      if (native && !setup) Notifications.clearLastNotificationResponse();
    }
    previousAccount.current = accountKey;
    suspended.current = false;
    if (!native || !accountKey) return;
    let active = true;
    void Promise.all([installationId(), SecureStore.getItemAsync(accountKey)]).then(([id, saved]) => {
      if (active) { setInstallation(id); setIntent({ key: accountKey, enabled: saved === 'enabled' }); }
    }).catch(e => { if (active) reportError(e); });
    return () => { active = false; };
  }, [accountKey, reportError]);

  useEffect(() => {
    if (!native || setup) return;
    let active = true;
    const read = () => { void Notifications.getPermissionsAsync().then(value => {
      if (active) { setPermission(value); setRefresh(n => n + 1); }
    }).catch(reportError); };
    read();
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') read(); });
    const token = Notifications.addPushTokenListener(() => setRefresh(n => n + 1));
    return () => { active = false; foreground.remove(); token.remove(); };
  }, [reportError]);

  // Keep foreground presentation quiet; unread state drives the badge reactively.
  useEffect(() => {
    if (!native || setup) return;
    Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
    const receive = (response: Notifications.NotificationResponse) => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = deliveryId(response.notification.request.content.data);
      if (id && queue.current.accept(id)) setPending({ deliveryId: id });
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(receive);
    const last = Notifications.getLastNotificationResponse();
    if (last) receive(last);
    return () => { subscription.remove(); Notifications.setNotificationHandler(null); };
  }, []);

  const execute = useCallback((work: () => Promise<void>) => {
    if (operation.current?.key === accountRef.current) return operation.current.promise;
    setBusy(true); setError(undefined);
    const promise = work().catch(e => { if (operation.current?.promise === promise) reportError(e); }).finally(() => { if (operation.current?.promise === promise) { operation.current = null; setBusy(false); } });
    operation.current = { key: accountRef.current, promise };
    return promise;
  }, [reportError]);
  const register = useCallback(async (key: string, request: boolean) => {
    if (setup || !installation || suspended.current) return;
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('messages', { name: 'Messages', importance: AndroidImportance.DEFAULT });
    let current = await Notifications.getPermissionsAsync();
    if (request && !allowed(current) && current.canAskAgain) current = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
    setPermission(current);
    if (key !== accountRef.current || suspended.current) return;
    if (!allowed(current)) {
      await convex.mutation(api.mobileNotifications.unregister, { installationId: installation });
      return;
    }
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    if (key !== accountRef.current || suspended.current) return;
    await convex.mutation(api.mobileNotifications.register, { installationId: installation, token: token.data, platform: Platform.OS as 'ios' | 'android' });
  }, [convex, installation]);
  useEffect(() => {
    if (optedIn && accountKey && permission && !setup) void execute(() => register(accountKey, false));
    // Permission objects change after registration; refresh is the explicit foreground/token trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optedIn, accountKey, refresh, register, execute]);

  const enable = useCallback(() => execute(async () => {
    if (!accountKey || !installation || setup) return;
    suspended.current = false;
    await SecureStore.setItemAsync(accountKey, 'enabled');
    if (accountRef.current !== accountKey) return;
    setIntent({ key: accountKey, enabled: true });
    await register(accountKey, true);
  }), [accountKey, installation, execute, register]);
  const disable = useCallback(() => execute(async () => {
    if (!accountKey || !installation) return;
    // Server first: an offline failure must not falsely report that delivery was disabled.
    await convex.mutation(api.mobileNotifications.unregister, { installationId: installation });
    await SecureStore.deleteItemAsync(accountKey);
    if (accountRef.current === accountKey) setIntent({ key: accountKey, enabled: false });
    await Notifications.setBadgeCountAsync(0);
  }), [accountKey, installation, convex, execute]);
  const beforeSignOut = useCallback(async () => {
    suspended.current = true;
    const connected = () => convex.connectionState().isWebSocketConnected;
    if (operation.current) await awaitWhileConnected(operation.current.promise, connected);
    if (native && installation && accountKey) {
      await SecureStore.deleteItemAsync(accountKey);
      setIntent({ key: accountKey, enabled: false });
      // Offline signout still revokes the server session, making its push registration inert.
      if (connected()) await awaitWhileConnected(convex.mutation(api.mobileNotifications.unregister, { installationId: installation }), connected);
      await Notifications.setBadgeCountAsync(0);
    }
    setPending(null);
  }, [accountKey, installation, convex]);
  useEffect(() => {
    if (native && !setup) void Notifications.setBadgeCountAsync(optedIn ? badge ?? 0 : 0).catch(reportError);
  }, [badge, optedIn, reportError]);

  const resolvePending = useCallback(async () => {
    const current = pendingRef.current;
    const key = accountRef.current;
    if (!current || !key) return null;
    const destination = await convex.query(api.mobileNotifications.resolve, { deliveryId: current.deliveryId });
    return accountRef.current === key && pendingRef.current?.deliveryId === current.deliveryId ? destination : null;
  }, [convex]);
  const approvePending = useCallback((id: string, destination: Destination) => setPending(current => current?.deliveryId === id ? { ...current, destination, approved: true } : current), []);
  const finishPending = useCallback((id: string) => {
    setPending(current => current?.deliveryId === id ? null : current);
    if (native && !setup) Notifications.clearLastNotificationResponse();
  }, []);
  return <Context.Provider value={{ setup, ready: !!accountKey && !!installation && intent?.key === accountKey, requested: optedIn, enabled: optedIn && !!status?.enabled && !!permission && allowed(permission), busy, denied: !!permission && !allowed(permission) && !permission.canAskAgain, error, enable, disable, beforeSignOut, pending, resolvePending, approvePending, finishPending, reportError }}>{children}</Context.Provider>;
}
