export type EditorStartup = { attempt: number; phase: 'opening' | 'ready' | 'failed' | 'interrupted'; error?: string };
export type StartupEvent = { type: 'ready'; attempt: number } | { type: 'failed' | 'interrupted'; attempt: number; error: string } | { type: 'retry'; protectedWork: boolean };

/** A reload is only safe before the editor has accepted user input. */
export function editorStartup(state: EditorStartup, event: StartupEvent): EditorStartup {
  if (event.type === 'retry') return (state.phase === 'failed' || state.phase === 'interrupted') && !event.protectedWork ? { attempt: state.attempt + 1, phase: 'opening' } : state;
  if (event.attempt !== state.attempt || state.phase === 'interrupted') return state;
  if (event.type === 'interrupted') return { ...state, phase: 'interrupted', error: event.error };
  if (state.phase === 'ready') return state;
  return event.type === 'ready' ? { attempt: state.attempt, phase: 'ready' } : { ...state, phase: 'failed', error: event.error };
}

/** Android WebView applies the system text zoom itself; iOS needs the bridge. */
export function documentFontScale(platform: string, fontScale: number): number {
  return platform === 'android' ? 1 : fontScale;
}
