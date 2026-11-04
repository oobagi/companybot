import { View } from 'react-native';
import { Button } from './Button';
import { ContentToolbarFrame } from './ContentToolbarFrame';
import type { ContentToolbarProps } from './ContentToolbar.types';

/** Web fallback; native platforms resolve to SwiftUI and Compose icon buttons. */
export function ContentToolbar({ actions, status, busy = false, accessibilityLabel }: ContentToolbarProps) {
  return <ContentToolbarFrame status={status} busy={busy} accessibilityLabel={accessibilityLabel}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {actions.map((action) => <Button key={action.id} label={action.label} variant="ghost" disabled={busy || action.disabled} onPress={action.onPress} />)}
    </View>
  </ContentToolbarFrame>;
}
