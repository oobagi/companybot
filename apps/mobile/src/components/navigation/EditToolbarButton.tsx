import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import Edit from '@expo/material-symbols/edit_square.xml';

/** Android toolbar items require an image; iOS keeps the conventional text Edit item. */
export function EditToolbarButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  if (Platform.OS === 'web') return null;
  return <Stack.Toolbar placement="right"><Stack.Toolbar.Button icon={process.env.EXPO_OS === 'android' ? Edit : undefined} accessibilityLabel={label} onPress={onPress} disabled={disabled}>Edit</Stack.Toolbar.Button></Stack.Toolbar>;
}
