export type EditorStartup = { attempt: number; phase: 'opening' | 'ready' | 'failed'; error?: string };
export type StartupEvent = { type: 'ready'; attempt: number } | { type: 'failed'; attempt: number; error: string } | { type: 'retry'; protectedWork: boolean };

/** A reload is only safe before the editor has accepted user input. */
export function editorStartup(state: EditorStartup, event: StartupEvent): EditorStartup {
  if (event.type === 'retry') return state.phase === 'failed' && !event.protectedWork ? { attempt: state.attempt + 1, phase: 'opening' } : state;
  if (event.attempt !== state.attempt || state.phase === 'ready') return state;
  return event.type === 'ready' ? { attempt: state.attempt, phase: 'ready' } : { ...state, phase: 'failed', error: event.error };
}

/** Android WebView applies the system text zoom itself; iOS needs the bridge. */
export function documentFontScale(platform: string, fontScale: number): number {
  return platform === 'android' ? 1 : fontScale;
}
