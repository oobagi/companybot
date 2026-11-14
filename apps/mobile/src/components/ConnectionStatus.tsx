import { useConvexConnectionState } from 'convex/react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/design';
import { Text } from './ui';

export function ConnectionStatus() {
  const connection = useConvexConnectionState();
  const { colors, spacing } = useTheme();
  if (connection.isWebSocketConnected) return null;
  return <SafeAreaView edges={['top', 'left', 'right']} style={{ padding: spacing.sm, backgroundColor: colors.warningSurface }}>
    <Text variant="caption" accessibilityLiveRegion="polite" style={{ color: colors.warning, textAlign: 'center' }}>Connecting to Companybot. Changes will sync when connected.</Text>
  </SafeAreaView>;
}
