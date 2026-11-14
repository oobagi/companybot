import { useState } from 'react';
import { View } from 'react-native';
import { ChoicePicker, EmptyState, ErrorState, Loading, Screen, ScreenList } from '@/components/ui';
import { useTheme } from '@/design';

/** The same feedback must center in each supported scroll owner. */
export function FeedbackExample({ kind }: { kind: 'Empty' | 'Loading' | 'Error' }) {
  const [container, setContainer] = useState('static');
  const [retried, setRetried] = useState(false);
  const { spacing } = useTheme();
  const content = kind === 'Empty'
    ? <EmptyState title="No pages yet" description="Keep notes, plans and team knowledge together." />
    : kind === 'Loading'
      ? <Loading label="Loading pages…" />
      : retried
        ? <EmptyState title="Ready to try again" description="Retry was handled by the example." />
        : <ErrorState layout="screen" message="We couldn’t load this page. Check your connection and try again. Any recovery drafts saved on this device will remain available." onRetry={() => setRetried(true)} />;
  return <View style={{ flex: 1 }}>
    <View style={{ paddingHorizontal: spacing.lg }}><ChoicePicker label="Container" presentation="compact" options={[
      { value: 'static', label: 'Static screen' },
      { value: 'scroll', label: 'Scrolling screen' },
      { value: 'list', label: 'Virtualized list' },
    ]} value={container} onChange={value => { if (typeof value === 'string') { setContainer(value); setRetried(false); } }} /></View>
    {container === 'list' ? <Screen nativeScroll padded={false}><ScreenList data={[]} renderItem={() => null} ListEmptyComponent={content} /></Screen>
      : <Screen key={container} scroll={container === 'scroll'}>{content}</Screen>}
  </View>;
}
