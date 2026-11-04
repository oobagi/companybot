import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { useAuthActions } from '@convex-dev/auth/react';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { convexUrl } from '@/lib/config';
import { api, errorMessage } from '@/lib/api';
import { WorkspaceContext, useMutation, useQuery } from '@/lib/convex';
import { ErrorState, Loading, Screen } from '@/components/ui';
import { Onboarding } from './Onboarding';
import { deviceZoneUpdate, WorkspaceSelection, workspaceStorageKey } from './selection';

type Mine = NonNullable<FunctionReturnType<typeof api.workspace.mine>>;
const SelectionContext = createContext<{ choose: (id: Id<'workspaces'>) => void } | null>(null);
export const useWorkspaceSelection = () => useContext(SelectionContext)!;

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const mine = useQuery(api.workspace.mine);
  const me = useQuery(api.workspace.me);
  if (mine === null || me === null) return <ErasedAccount />;
  if (!mine || !me) return <Screen><Loading label="Opening your workspace…" /></Screen>;
  return <AccountWorkspaces key={me.userId} userId={me.userId} mine={mine}>{children}</AccountWorkspaces>;
}

function ErasedAccount() {
  const { signOut } = useAuthActions();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void signOut().catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [signOut, attempt]);
  return <Screen>{error ? <ErrorState message={error} onRetry={() => { setError(undefined); setAttempt(n => n + 1); }} /> : <Loading label="Signing out…" />}</Screen>;
}

function AccountWorkspaces({ userId, mine, children }: { userId: Id<'users'>; mine: Mine; children: ReactNode }) {
  const [selection] = useState(() => new WorkspaceSelection(mine.workspaces.map(w => w.id), mine.lastUsed));
  const state = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
  const remember = useMutation(api.workspace.switchTo);
  const storageKey = workspaceStorageKey(convexUrl ?? '', userId);
  const persistence = useRef(Promise.resolve());
  useEffect(() => { selection.reconcile(mine.workspaces.map(w => w.id)); }, [mine.workspaces, selection]);
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(storageKey).catch(() => null).then(saved => { if (active) selection.hydrate(saved); });
    return () => { active = false; };
  }, [storageKey, selection]);
  useEffect(() => {
    if (!state.hydrated || !state.selected || state.pending) return;
    // Serialize writes: a slow previous workspace write must not overwrite a newer one.
    const id = state.selected;
    persistence.current = persistence.current.then(() => AsyncStorage.setItem(storageKey, id)).catch(() => {});
  }, [state.hydrated, state.selected, state.pending, storageKey, persistence]);
  useEffect(() => {
    if (!state.pending) return;
    const pending = state.pending;
    const timer = setTimeout(() => selection.rejectPending(pending), 15_000);
    return () => clearTimeout(timer);
  }, [state.pending, selection]);
  const choose = useCallback((id: Id<'workspaces'>) => selection.choose(id), [selection]);
  const open = useCallback((id: Id<'workspaces'>) => {
    if (!selection.open(id)) return false;
    void remember({ to: id }).catch(() => {});
    return true;
  }, [remember, selection]);
  const workspace = useMemo(() => state.selected ? { id: state.selected as Id<'workspaces'>, open } : null, [state.selected, open]);
  if (state.error) return <Screen><ErrorState message={state.error} onRetry={selection.clearError} /></Screen>;
  if (!state.hydrated || state.pending) return <Screen><Loading label="Opening your workspace…" /></Screen>;
  if (!mine.workspaces.length) return <EnsureWorkspace onDone={choose} />;
  if (!workspace || !mine.workspaces.some(w => w.id === workspace.id)) return <Screen><Loading label="Checking workspace access…" /></Screen>;
  return <SelectionContext.Provider value={{ choose }}><WorkspaceContext.Provider value={workspace}><WorkspaceContents key={workspace.id}>{children}</WorkspaceContents></WorkspaceContext.Provider></SelectionContext.Provider>;
}

/** Remounts whenever the account has no workspaces, so each new empty period checks invites. */
function EnsureWorkspace({ onDone }: { onDone: (id: Id<'workspaces'>) => void }) {
  const ensure = useMutation(api.workspace.ensure);
  const convex = useConvex();
  const [status, setStatus] = useState<'checking' | 'empty' | 'joined'>('checking');
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    // Re-read after the transaction: stale empty subscription data must not flash onboarding.
    void ensure().then(() => convex.query(api.workspace.mine, {})).then(mine => {
      if (active) setStatus(mine?.workspaces.length ? 'joined' : 'empty');
    }).catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [ensure, convex, attempt]);
  if (error) return <Screen><ErrorState message={error} onRetry={() => { setError(undefined); setStatus('checking'); setAttempt(n => n + 1); }} /></Screen>;
  return status === 'empty' ? <Onboarding onDone={onDone} /> : <Screen><Loading label="Checking your invitations…" /></Screen>;
}

function WorkspaceContents({ children }: { children: ReactNode }) {
  const me = useQuery(api.workspace.me);
  const preferences = useQuery(api.preferences.get);
  const update = useMutation(api.preferences.update);
  useEffect(() => {
    if (!preferences) return;
    let previous = preferences.deviceTimeZone;
    const refresh = () => {
      const change = deviceZoneUpdate(Intl.DateTimeFormat().resolvedOptions().timeZone, previous);
      if (change) void update(change).then(() => { previous = change.deviceTimeZone; }).catch(() => {});
    };
    refresh();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => subscription.remove();
  }, [preferences, update]);
  if (!me?.role) return <Screen><Loading label="Checking workspace access…" /></Screen>;
  return children;
}
