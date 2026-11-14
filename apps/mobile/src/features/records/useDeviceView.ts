import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { defaultView, type Database, type SavedView, type ViewConfig } from './model';
import { deviceViewKey, restoreDeviceView } from './deviceView';

export function useDeviceView(workspaceId: string, database: Database, currency: string | undefined, view?: SavedView) {
  const key = view && deviceViewKey(workspaceId, database._id, view._id);
  const [stored, setStored] = useState<{ key: string; raw: string | null; error?: string }>();
  useEffect(() => {
    if (!key) return;
    let active = true;
    void AsyncStorage.getItem(key).then(raw => { if (active) setStored({ key, raw }); }).catch(() => { if (active) setStored({ key, raw: null, error: 'Device view preferences could not be loaded.' }); });
    return () => { active = false; };
  }, [key]);
  const state = view ? restoreDeviceView(stored && stored.key === key ? stored.raw : null, database, currency ?? 'USD', view) : { config: defaultView(database), baseVersion: undefined, local: false };
  const write = useCallback(async (raw: string | null) => {
    if (!key) return;
    // A sheet may still own a deleted view while the screen has moved to another.
    // Persist that original key without replacing the new view's loaded state.
    setStored(current => current?.key === key ? { key, raw } : current);
    try { if (raw === null) await AsyncStorage.removeItem(key); else await AsyncStorage.setItem(key, raw); }
    catch { setStored(current => current?.key === key ? { ...current, error: 'This view is applied, but could not be remembered on this device.' } : current); }
  }, [key]);
  return {
    ...state,
    loaded: !!key && stored?.key === key && currency !== undefined,
    set: (config: ViewConfig) => write(JSON.stringify({ config, baseVersion: state.baseVersion })),
    reset: () => write(null),
    error: stored?.key === key ? stored?.error : undefined,
  };
}
