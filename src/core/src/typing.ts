// Typing indicators (backend typing.ts, app views/chat/Typing.tsx). The app pings at most every
// TYPING_PING_MS while someone types; a ping counts for TYPING_MS, a little longer, so steady
// typing never flickers. Like Discord's, there's no "stopped typing": it runs out, or sending clears it.

export const TYPING_PING_MS = 4_000;
export const TYPING_MS = 6_000;
