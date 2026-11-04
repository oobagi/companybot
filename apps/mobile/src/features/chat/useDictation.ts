import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { useAction } from '@/lib/convex';

type State = 'idle' | 'starting' | 'recording' | 'transcribing';
const MAX_DURATION_MS = 120_000;
const MAX_BYTES = 4 * 1024 * 1024;

/** A foreground-only recording becomes editable draft text, never an automatic send. */
export function useDictation(onText: (text: string) => void) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64_000 });
  const transcribe = useAction(api.dictation.transcribeAudio);
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string>();
  const current = useRef<State>('idle');
  const epoch = useRef(0);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ onText, transcribe });
  useEffect(() => { latest.current = { onText, transcribe }; }, [onText, transcribe]);
  const transition = (next: State) => { current.current = next; setState(next); };
  const erase = useCallback((uri: string | null) => {
    if (uri && Platform.OS !== 'web') { try { new File(uri).delete(); } catch { /* Cache cleanup is best effort. */ } }
  }, []);
  const cancel = useCallback(() => {
    epoch.current++;
    clearTimeout(timer.current);
    current.current = 'idle';
    if (focused.current) setState('idle');
    try { if (recorder.isRecording) void recorder.stop().then(() => erase(recorder.uri)).catch(() => {}); } catch { /* Hook may already have released native recorder. */ }
    void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
  }, [recorder, erase]);
  useFocusEffect(useCallback(() => { focused.current = true; return () => { focused.current = false; cancel(); }; }, [cancel]));
  useEffect(() => { const subscription = AppState.addEventListener('change', (next) => { if (next !== 'active' && current.current !== 'idle') cancel(); }); return () => subscription.remove(); }, [cancel]);
  const finish = async () => {
    if (current.current !== 'recording') return;
    const request = epoch.current;
    clearTimeout(timer.current);
    transition('transcribing');
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
      await setAudioModeAsync({ allowsRecording: false });
      if (!focused.current || request !== epoch.current || AppState.currentState !== 'active') return;
      if (!uri) throw new Error('No recording was captured. Try again.');
      const file = Platform.OS === 'web' ? await (await fetch(uri)).blob() : new File(uri);
      if (file.size > MAX_BYTES) throw new Error('That recording is too long. Try a shorter one.');
      const audio = await file.arrayBuffer();
      const text = await latest.current.transcribe({ audio });
      if (focused.current && request === epoch.current && text.trim()) latest.current.onText(text.trim());
    } catch (e) { if (focused.current && request === epoch.current) setError(errorMessage(e)); }
    finally { erase(uri); if (focused.current && request === epoch.current) transition('idle'); }
  };
  const finishRef = useRef(finish);
  useEffect(() => { finishRef.current = finish; });
  const start = async () => {
    if (current.current !== 'idle' || AppState.currentState !== 'active') return;
    const request = ++epoch.current;
    transition('starting'); setError(undefined);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!focused.current || request !== epoch.current || AppState.currentState !== 'active') return;
      if (!permission.granted) throw new Error('Allow microphone access in system settings to dictate a message.');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
      await recorder.prepareToRecordAsync();
      if (!focused.current || request !== epoch.current || AppState.currentState !== 'active') { await setAudioModeAsync({ allowsRecording: false }); return; }
      recorder.record();
      transition('recording');
      timer.current = setTimeout(() => void finishRef.current(), MAX_DURATION_MS);
    } catch (e) { if (focused.current && request === epoch.current) { setError(errorMessage(e)); transition('idle'); } void setAudioModeAsync({ allowsRecording: false }).catch(() => {}); }
  };
  return { state, error, toggle: () => current.current === 'recording' ? finish() : start(), cancel };
}
