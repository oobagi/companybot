import { useState, type ReactNode } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '@/design';
import { FloatingBar } from './FloatingBar';

type MessageInputProps = Pick<TextInputProps, 'accessibilityLabel' | 'placeholder' | 'value' | 'onChangeText' | 'editable'> & {
  leading: ReactNode;
  trailing: ReactNode;
};

/** Shared composer chrome; drafts and actions stay with the owning feature. */
export function MessageInput({ leading, trailing, ...input }: MessageInputProps) {
  const { colors, spacing, typography, sizes } = useTheme();
  const [contentHeight, setContentHeight] = useState(44);
  return <FloatingBar><View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs }}>
    {leading}
    <TextInput {...input} multiline submitBehavior="newline"
      onContentSizeChange={event => setContentHeight(Math.ceil(event.nativeEvent.contentSize.height))}
      scrollEnabled={contentHeight >= 144} placeholderTextColor={colors.muted} selectionColor={colors.link} underlineColorAndroid="transparent"
      style={[typography.body, { flex: 1, height: Math.max(44, Math.min(144, contentHeight)), minHeight: 44, maxHeight: 144, marginVertical: (sizes.touch - 44) / 2, paddingHorizontal: spacing.xs, paddingVertical: spacing.sm, color: colors.text, textAlignVertical: 'top' }]} />
    {trailing}
  </View></FloatingBar>;
}
