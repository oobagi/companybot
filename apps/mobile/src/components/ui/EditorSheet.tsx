import { useState, type ReactNode } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { Button } from './Button';
import { Field } from './Field';
import { ListRow } from './ListRow';
import { Screen, Stack } from './Layout';
import { Text } from './Text';
import { useTheme } from '@/design';
import { SheetHeader } from './native-controls/SheetHeader';
import { ChoiceMenu } from './native-controls/ChoiceMenu';
import type { ChoiceOption } from './native-controls/ChoiceMenu.types';

export function EditorSheet({ title, children, onClose, onDismiss, open = true, busy = false, dismissible = true, size = 'large' }: { title: string; children: ReactNode; onClose: () => void; onDismiss?: () => void; open?: boolean; busy?: boolean; dismissible?: boolean; size?: 'large' | 'content' }) {
  const { colors, spacing } = useTheme();
  const header = <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}><SheetHeader title={title} onClose={onClose} busy={busy} /></View>;
  // Native onClose fires after dismissal. Guarded drafts must use the Close button so their
  // confirmation runs while the sheet is still visible, and cancelling keeps their edits intact.
  return <BottomSheet index={open ? 0 : -1} snapPoints={size === 'large' ? ['90%'] : undefined} enableDynamicSizing={size === 'content'} enablePanDownToClose={dismissible && !busy} backgroundStyle={{ backgroundColor: colors.background }} onClose={() => { if (!busy) onClose(); }} onDismiss={onDismiss}>
    {size === 'content' ? <View>{header}<Stack style={{ padding: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl }}>{children}</Stack></View> : <Screen padded={false} edges={['left', 'right', 'bottom']}>
      {header}
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets contentContainerStyle={{ flexGrow: 1, padding: spacing.lg, paddingTop: spacing.sm }}>
        <Stack style={{ flexGrow: 1 }}>{children}</Stack>
      </ScrollView>
    </Screen>}
  </BottomSheet>;
}

export function ChoicePicker({ label, options, value, onChange, multiple = false, disabled = false, allowEmpty = false, emptyLabel = 'None' }: {
  label: string; options: ChoiceOption[]; value: string | string[]; onChange: (value: string | string[]) => void; multiple?: boolean; disabled?: boolean; allowEmpty?: boolean; emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = Array.isArray(value) ? value : [value];
  const text = selected.filter(Boolean).map(v => options.find(o => o.value === v)?.label ?? 'Unavailable').join(', ') || (multiple || allowEmpty ? emptyLabel : 'Choose…');
  const choices = !multiple && allowEmpty ? [{ value: '', label: emptyLabel }, ...options.filter(o => o.value !== '')] : options;
  if (!multiple && !disabled && choices.length > 0 && choices.length <= 8 && Platform.OS !== 'web') return <ChoiceMenu label={`${label}, ${text}`} options={choices} value={selected[0] ?? ''} onChange={onChange}>
    <ListRow title={label} description={text} trailing={<Text tone="muted">⌄</Text>} />
  </ChoiceMenu>;
  const filtered = choices.filter(o => o.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <View><ListRow title={label} description={text} onPress={() => { setSearch(''); setOpen(true); }} disabled={disabled} />
    {open && <EditorSheet title={label} onClose={() => setOpen(false)}>
      {(options.length > 8 || multiple) && <Field label="Search options" value={search} onChangeText={setSearch} autoCorrect={false} />}
      {filtered.map(o => <ListRow key={o.value} title={o.label} disabled={disabled || o.disabled} selected={selected.includes(o.value)} trailing={<Text tone="muted">{selected.includes(o.value) ? '✓' : ''}</Text>} onPress={() => { onChange(multiple ? selected.includes(o.value) ? selected.filter(v => v !== o.value) : [...selected.filter(Boolean), o.value] : o.value); if (!multiple) setOpen(false); }} />)}
      {!filtered.length && <Text tone="muted">{search ? 'No matching options.' : 'No options available.'}</Text>}
      {multiple && <Button label="Done" onPress={() => setOpen(false)} />}
    </EditorSheet>}
  </View>;
}

export function ConfirmSheet({ title, message, confirmLabel = 'Confirm', destructive = false, busy = false, error, onConfirm, onClose }: {
  title: string; message: string; confirmLabel?: string; destructive?: boolean; busy?: boolean; error?: string; onConfirm: () => void; onClose: () => void;
}) {
  return <EditorSheet title={title} onClose={onClose} busy={busy} size="content">
    <Text>{message}</Text>
    {error && <Text tone="danger" accessibilityRole="alert">{error}</Text>}
    <Button label={confirmLabel} variant={destructive ? 'danger' : 'primary'} loading={busy} onPress={onConfirm} />
    <Button label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
  </EditorSheet>;
}
