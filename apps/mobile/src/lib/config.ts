export const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
export const backendConfigured = !!convexUrl && /^https?:\/\//.test(convexUrl);
