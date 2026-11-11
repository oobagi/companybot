import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ConvexReactClient, useConvexAuth } from 'convex/react';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '@/design';
import { EmptyState, ErrorState, Loading, Screen } from '@/components/ui';
import { NotificationsProvider } from '@/lib/notifications/NotificationsProvider';
import { UnsavedWorkProvider } from '@/lib/UnsavedWork';
import { SessionLinks } from '@/features/session/SessionLinks';
import { tokenStorage } from '@/lib/tokenStorage';
import { backendConfigured, convexUrl } from '@/lib/config';

const client = backendConfigured ? new ConvexReactClient(convexUrl!, { unsavedChangesWarning: false }) : null;

export default function RootLayout() {
  return <SafeAreaProvider><ThemeProvider><StatusBar style="auto" />{client ? <ConvexAuthProvider client={client} storage={tokenStorage} shouldHandleCode={false}><SessionLinks><UnsavedWorkProvider><NotificationsProvider><SessionRoutes /></NotificationsProvider></UnsavedWorkProvider></SessionLinks></ConvexAuthProvider> : <Screen edges={['top', 'left', 'right', 'bottom']}><EmptyState title="Connect Companybot" description="Set EXPO_PUBLIC_CONVEX_URL in apps/mobile/.env.local to your Convex deployment, then restart Expo." /></Screen>}</ThemeProvider></SafeAreaProvider>;
}

function SessionRoutes() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { colors } = useTheme();
  if (isLoading) return <Screen><Loading label="Signing you in…" /></Screen>;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Protected guard={!isAuthenticated}><Stack.Screen name="sign-in" /></Stack.Protected>
    <Stack.Protected guard={isAuthenticated}><Stack.Screen name="(app)" /></Stack.Protected>
  </Stack>;
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <SafeAreaProvider><ThemeProvider><Screen edges={['top', 'left', 'right', 'bottom']}><ErrorState message={error.message} onRetry={retry} /></Screen></ThemeProvider></SafeAreaProvider>;
}
