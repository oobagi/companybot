import { createContext, useContext, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Switch, View, useWindowDimensions } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from './Button';
import { Field } from './Field';
import { Screen, Stack } from './Layout';
import { Text } from './Text';
import { useTheme } from '@/design';
import { SheetHeader } from './native-controls/SheetHeader';
import type { SheetHeaderProps } from './native-controls/SheetHeader.types';
import { ChoiceMenu } from './native-controls/ChoiceMenu';
import type { ChoiceOption } from './native-controls/ChoiceMenu.types';

const SheetContext = createContext<{ busy: boolean } | null>(null);

export function EditorSheet({ title, children, onClose, onDismiss, open = true, busy = false, dismissible = true, size = 'large', scroll = true, submit }: { title: string; children: ReactNode; onClose: () => void; onDismiss?: () => void; open?: boolean; busy?: boolean; dismissible?: boolean; size?: 'large' | 'content'; scroll?: boolean; submit?: SheetHeaderProps['submit'] }) {
  const { colors, spacing } = useTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const header = <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}><SheetHeader title={title} onClose={onClose} busy={busy} submit={submit} /></View>;
  // The native sheet owns keyboard avoidance. RN automatic keyboard insets would
  // also scroll a focused field while the sheet moves, pushing it behind the header.
  // Native onClose fires after dismissal. Guarded drafts must use the Close button so their
  // confirmation runs while the sheet is still visible, and cancelling keeps their edits intact.
  return <BottomSheet index={open ? 0 : -1} snapPoints={size === 'large' ? ['90%'] : undefined} enableDynamicSizing={size === 'content'} enablePanDownToClose={dismissible && !busy} backgroundStyle={{ backgroundColor: colors.background }} onClose={() => { if (!busy) onClose(); }} onDismiss={onDismiss}><SheetContext.Provider value={{ busy }}>
    {size === 'content' ? <View style={{ maxHeight: Math.max(0, height - insets.top - insets.bottom - spacing.xl) }}>{header}
      {scroll ? <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets={false} automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl }}><Stack>{children}</Stack></ScrollView>
        : <Stack style={{ padding: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl }}>{children}</Stack>}
    </View> : <Screen padded={false} edges={['left', 'right', 'bottom']}>
      {header}
      {scroll ? <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets={false} automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" contentContainerStyle={{ flexGrow: 1, padding: spacing.lg, paddingTop: spacing.sm }}>
        <Stack style={{ flexGrow: 1 }}>{children}</Stack>
      </ScrollView> : <Stack style={{ flex: 1, paddingHorizontal: spacing.lg }}>{children}</Stack>}
    </Screen>}
  </SheetContext.Provider></BottomSheet>;
}

export function ChoicePicker({ label, options, value, onChange, multiple = false, disabled = false, allowEmpty = false, emptyLabel = 'None', presentation = 'row' }: {
  label: string; options: ChoiceOption[]; value: string | string[]; onChange: (value: string | string[]) => void; multiple?: boolean; disabled?: boolean; allowEmpty?: boolean; emptyLabel?: string; presentation?: 'row' | 'compact';
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(40);
  const sheet = useContext(SheetContext);
  const { colors, sizes, spacing, radii } = useTheme();
  const { fontScale } = useWindowDimensions();
  const unavailable = disabled || !!sheet?.busy;
  const selected = Array.isArray(value) ? value : [value];
  const text = selected.filter(Boolean).map(v => options.find(o => o.value === v)?.label ?? 'Unavailable').join(', ') || (multiple || allowEmpty ? emptyLabel : 'Choose…');
  const choices = !multiple && allowEmpty ? [{ value: '', label: emptyLabel }, ...options.filter(o => o.value !== '')] : options;
  const choose = (option: ChoiceOption) => {
    if (unavailable || option.disabled) return;
    onChange(multiple ? selected.includes(option.value) ? selected.filter(value => value !== option.value) : [...selected.filter(Boolean), option.value] : option.value);
    if (!multiple) setOpen(false);
  };
  const compact = presentation === 'compact';
  const stacked = !compact && fontScale >= 1.5;
  const trigger = <View style={{ minHeight: sizes.touch, minWidth: sizes.touch, paddingVertical: spacing.sm, paddingHorizontal: compact ? spacing.sm : 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, opacity: unavailable ? 0.5 : 1 }}>
    <View style={{ flex: compact ? undefined : 1, flexShrink: 1, minWidth: 0, flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: stacked ? spacing.xs : spacing.md }}>
      {!compact && <Text style={{ flexShrink: 1, maxWidth: stacked ? undefined : '50%' }}>{label}</Text>}
      <Text tone={compact ? 'default' : 'muted'} style={{ flex: compact || stacked ? undefined : 1, flexShrink: 1, textAlign: compact || stacked ? 'left' : 'right' }}>{text}</Text>
    </View>
    <SymbolView name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }} size={sizes.icon} tintColor={compact ? colors.text : colors.muted} />
  </View>;
  if (!multiple && !unavailable && choices.length > 0 && choices.length <= 8 && Platform.OS !== 'web') return <ChoiceMenu label={label} selectionLabel={text} presentation={presentation} options={choices} value={selected[0] ?? ''} onChange={value => { const option = choices.find(choice => choice.value === value); if (option) choose(option); }}>
    {trigger}
  </ChoiceMenu>;
  const filtered = choices.filter(o => o.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const picker = <Stack gap="sm">
      {(options.length > 8 || multiple) && <Field label={`Search ${label.toLocaleLowerCase()}`} value={search} onChangeText={value => { setSearch(value); setLimit(40); }} editable={!unavailable} autoCorrect={false} />}
      {filtered.slice(0, limit).map(option => {
        const checked = selected.includes(option.value);
        const locked = unavailable || option.disabled;
        return multiple ? <Stack key={option.value} horizontal style={{ minHeight: sizes.touch, paddingHorizontal: spacing.md }}><Text style={{ flex: 1 }}>{option.label}</Text><Switch accessibilityLabel={option.label} value={checked} disabled={locked} onValueChange={() => choose(option)} trackColor={{ true: colors.primary }} /></Stack>
          : <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked, disabled: !!locked }} disabled={locked} onPress={() => choose(option)} style={({ pressed }) => ({ minHeight: sizes.touch, padding: spacing.md, borderRadius: radii.md, flexDirection: 'row', gap: spacing.md, alignItems: 'center', backgroundColor: checked ? colors.selected : pressed ? colors.pressed : undefined, opacity: locked ? 0.5 : 1 })}><Text style={{ flex: 1 }}>{option.label}</Text>{checked && <Text tone="link">✓</Text>}</Pressable>;
      })}
      {!filtered.length && <Text tone="muted">{search ? 'No matching options.' : 'No options available.'}</Text>}
      {filtered.length > limit && <Button label={`Show more options (${filtered.length - limit} remaining)`} variant="ghost" disabled={unavailable} onPress={() => setLimit(value => value + 40)} />}
      {(multiple || sheet) && <Button label="Done" variant="secondary" disabled={unavailable} onPress={() => setOpen(false)} />}
    </Stack>;
  return <View style={{ alignSelf: compact ? 'flex-start' : 'stretch', maxWidth: '100%' }}><Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${text}`} accessibilityState={{ disabled: unavailable, expanded: open }} onPress={() => { setSearch(''); setLimit(40); setOpen(value => !value); }} disabled={unavailable} style={({ pressed }) => ({ borderRadius: radii.sm, backgroundColor: pressed ? colors.pressed : undefined })}>{trigger}</Pressable>
    {open && (sheet ? <View style={{ padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md }}>{picker}</View> : <EditorSheet title={label} onClose={() => setOpen(false)}>{picker}</EditorSheet>)}
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
