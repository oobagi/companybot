import { useEffect, useLayoutEffect, useReducer, useRef, type ComponentProps } from 'react';
import { View } from 'react-native';
import { ErrorState, Loading } from '@/components/ui';
import { useTheme } from '@/design';
import DocumentDOM from './Editor.dom';
import { editorStartup } from './editorStartup';

/** Keeps a failed WebView retryable without replacing an editor holding a draft. */
export function DocumentSurface({ protectedWork = false, onReadyChange, ...props }: ComponentProps<typeof DocumentDOM> & { protectedWork?: boolean; onReadyChange?: (ready: boolean) => void }) {
  const theme = useTheme();
  const [startup, dispatch] = useReducer(editorStartup, { attempt: 0, phase: 'opening' });
  const attempt = useRef(startup.attempt);
  useLayoutEffect(() => { attempt.current = startup.attempt; }, [startup.attempt]);
  useEffect(() => { onReadyChange?.(startup.phase === 'ready'); }, [onReadyChange, startup.phase]);
  useEffect(() => {
    if (startup.phase !== 'opening') return;
    // Metro compiles the DOM bundle on first use; packaged builds already have it.
    const timer = setTimeout(() => dispatch({ type: 'failed', attempt: startup.attempt, error: 'The editor did not finish opening. Check your connection and try again.' }), __DEV__ ? 60_000 : 15_000);
    return () => clearTimeout(timer);
  }, [startup.attempt, startup.phase]);
  return <View style={{ flex: 1, minHeight: 0 }}>
    <DocumentDOM key={startup.attempt} {...props} onStatus={async (dirty, error) => {
      if (attempt.current !== startup.attempt) return;
      dispatch(error && !dirty ? { type: 'failed', attempt: startup.attempt, error } : { type: 'ready', attempt: startup.attempt });
      if (startup.phase !== 'ready' && error && !dirty) return;
      await props.onStatus(dirty, error);
    }} />
    {startup.phase !== 'ready' && <View style={{ position: 'absolute', inset: 0, backgroundColor: theme.colors.background }}>
      {startup.phase === 'failed' ? <ErrorState message={startup.error!} onRetry={protectedWork ? undefined : () => dispatch({ type: 'retry', protectedWork })} /> : <Loading label="Opening editor…" />}
    </View>}
  </View>;
}
