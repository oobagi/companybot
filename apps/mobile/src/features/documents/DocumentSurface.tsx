import { useEffect, useLayoutEffect, useReducer, useRef, type ComponentProps } from 'react';
import { View } from 'react-native';
import { Button, EmptyState, ErrorState, Loading, Stack } from '@/components/ui';
import { useTheme } from '@/design';
import DocumentDOM from './Editor.dom';
import { editorStartup } from './editorStartup';

/** Keeps a failed WebView retryable without replacing an editor holding a draft. */
export function DocumentSurface({ protectedWork = false, onReadyChange, onReloadSaved, onInterrupted, onReviewDraft, ...props }: ComponentProps<typeof DocumentDOM> & { protectedWork?: boolean; onReadyChange?: (ready: boolean) => void; onReloadSaved?: () => Promise<boolean>; onInterrupted?: () => void; onReviewDraft?: () => void }) {
  const theme = useTheme();
  const [startup, dispatch] = useReducer(editorStartup, { attempt: 0, phase: 'opening' });
  const attempt = useRef(startup.attempt);
  const interrupted = useRef(false);
  const recovering = useRef(false);
  useLayoutEffect(() => { attempt.current = startup.attempt; }, [startup.attempt]);
  useEffect(() => { onReadyChange?.(startup.phase === 'ready'); }, [onReadyChange, startup.phase]);
  useEffect(() => {
    if (startup.phase !== 'opening') return;
    // Metro compiles the DOM bundle on first use; packaged builds already have it.
    const timer = setTimeout(() => dispatch({ type: 'failed', attempt: startup.attempt, error: 'The editor did not finish opening. Check your connection and try again.' }), __DEV__ ? 60_000 : 15_000);
    return () => clearTimeout(timer);
  }, [startup.attempt, startup.phase]);
  const processLost = () => {
    if (attempt.current !== startup.attempt || interrupted.current) return;
    // Override Expo's automatic reload: pending commands/uploads must not replay,
    // and a new editor must start from the current saved snapshot.
    interrupted.current = true;
    onInterrupted?.();
    dispatch({ type: 'interrupted', attempt: startup.attempt, error: 'The editor closed unexpectedly. Reload the saved document to continue. Changes that were still saving may be missing.' });
  };
  const retry = async () => {
    if (recovering.current) return;
    recovering.current = true;
    try {
      if (protectedWork && !(startup.phase === 'interrupted' && await onReloadSaved?.())) return;
      interrupted.current = false;
      dispatch({ type: 'retry', protectedWork: false });
    } finally { recovering.current = false; }
  };
  return <View style={{ flex: 1, minHeight: 0 }}>
    {/* A terminated native view cannot be reused or left accessible under the recovery UI. */}
    {startup.phase !== 'interrupted' && <DocumentDOM key={startup.attempt} {...props} dom={{ ...props.dom, onContentProcessDidTerminate: processLost, onRenderProcessGone: processLost }} onRecoverySnapshot={async snapshot => {
      if (attempt.current !== startup.attempt || interrupted.current) return;
      await props.onRecoverySnapshot?.(snapshot);
    }} onStatus={async (dirty, error) => {
      if (attempt.current !== startup.attempt || interrupted.current) return;
      dispatch(error && !dirty ? { type: 'failed', attempt: startup.attempt, error } : { type: 'ready', attempt: startup.attempt });
      if (startup.phase !== 'ready' && error && !dirty) return;
      await props.onStatus(dirty, error);
    }} />}
    {startup.phase !== 'ready' && <View style={{ position: 'absolute', inset: 0, backgroundColor: theme.colors.background }}>
      {startup.phase === 'interrupted' && onReviewDraft ? <EmptyState title="Editor interrupted" description="A recovery copy of your unsaved draft is available. Review and copy it before reloading." action={<Stack><Button label="Review unsaved draft" onPress={onReviewDraft} /><Button label="Reload saved document" variant="secondary" onPress={() => { void retry(); }} /></Stack>} /> : startup.phase !== 'opening' ? <ErrorState layout="screen" message={startup.error!} onRetry={protectedWork && !(startup.phase === 'interrupted' && onReloadSaved) ? undefined : () => { void retry(); }} /> : <Loading label="Opening editor…" />}
    </View>}
  </View>;
}
