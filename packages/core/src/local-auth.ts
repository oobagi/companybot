/**
 * A local backend (`pnpm dev`) sends no sign-in email: the app reads the code back
 * and signs straight in (backend auth.ts). Only for loopback addresses; Convex sets
 * CONVEX_CLOUD_URL itself, so a cloud deployment can never take this path.
 */
export const isLocalBackend = (url: string | undefined) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url ?? "");
