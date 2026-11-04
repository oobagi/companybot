import { useEffect, useState } from 'react';
import { Alert, Modal, Platform, View } from 'react-native';
import { Button } from './Button';
import { Card, Stack } from './Layout';
import { Text } from './Text';
import { useTheme } from '@/design';
import { createConfirmationController, type ConfirmationQuestion } from './native-controls/confirmation';

export function useConfirm() {
  const [web, setWeb] = useState<{ question: ConfirmationQuestion; settle: (answer: boolean) => void }>();
  const { colors, spacing, sizes } = useTheme();
  const [controller] = useState(() => createConfirmationController((question, settle) => {
    if (Platform.OS === 'web') { setWeb({ question, settle }); return; }
    Alert.alert(question.title, question.body, [
      { text: 'Cancel', style: 'cancel', isPreferred: !!question.danger, onPress: () => settle(false) },
      { text: question.action ?? 'Continue', style: question.danger ? 'destructive' : 'default', onPress: () => settle(true) },
    ], { cancelable: true, onDismiss: () => settle(false) });
  }));
  useEffect(() => () => controller.cancel(), [controller]);
  const settleWeb = (answer: boolean) => { web?.settle(answer); setWeb(undefined); };
  return { confirm: controller.confirm, dialog: Platform.OS !== 'web' ? null : <Modal visible={!!web} transparent animationType="fade" onRequestClose={() => settleWeb(false)}>
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl, backgroundColor: colors.overlay }}>
      <Card accessibilityViewIsModal style={{ width: '100%', maxWidth: sizes.content }}>
        <Text variant="heading">{web?.question.title}</Text><Text>{web?.question.body}</Text>
        <Stack><Button label={web?.question.action ?? 'Continue'} variant={web?.question.danger ? 'danger' : 'primary'} onPress={() => settleWeb(true)} /><Button label="Cancel" variant="secondary" onPress={() => settleWeb(false)} /></Stack>
      </Card>
    </View>
  </Modal> };
}
