import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import type { Database, ViewConfig } from './model';
import { deviceViewKey, restoreDeviceView } from './deviceView';

export function useDeviceView(workspaceId: string, database: Database, currency: string | undefined) {
  const key = deviceViewKey(workspaceId, database._id);
  const [stored, setStored] = useState<{ key: string; raw: string | null }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(key).then(raw => { if (active) setStored({ key, raw }); }).catch(() => { if (active) { setStored({ key, raw: null }); setError('Device view preferences could not be loaded.'); } });
    return () => { active = false; };
  }, [key]);
  const set = useCallback((config: ViewConfig) => {
    const raw = JSON.stringify(config);
    setStored({ key, raw }); setError(undefined);
    void AsyncStorage.setItem(key, raw).catch(() => setError('This view is applied, but could not be remembered on this device.'));
  }, [key]);
  return { config: restoreDeviceView(stored?.key === key ? stored.raw : null, database, currency ?? 'USD'), loaded: stored?.key === key && currency !== undefined, set, error };
}
