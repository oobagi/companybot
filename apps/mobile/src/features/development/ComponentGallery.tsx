import { useCallback, useState } from 'react';
import { Appearance, View } from 'react-native';
import { Redirect, Stack as RouterStack, useFocusEffect } from 'expo-router';
import Edit from '@expo/material-symbols/edit.xml';
import Photo from '@expo/material-symbols/add_photo_alternate.xml';
import More from '@expo/material-symbols/more_horiz.xml';
import History from '@expo/material-symbols/history.xml';
import { ThemeProvider, useTheme } from '@/design';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import { ActionMenu, Avatar, Button, ChoicePicker, EditorSheet, Field, ListRow, PropertyRow, Screen, Section, Stack, Text } from '@/components/ui';
import { SettingsList } from '@/components/ui/SettingsList';
import { ContentToolbar } from '@/components/ui/ContentToolbar';
import { DateInput } from '@/components/ui/native-controls/DateInput';
import { TimeInput } from '@/components/ui/native-controls/TimeInput';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { DirectoryExample } from './DirectoryExample';
import { FeedbackExample } from './FeedbackExample';
import { PendingMessageRow } from '@/features/chat/PendingMessageRow';
import { ConversationExample } from './ConversationExample';
import { RichText } from '@/features/chat/RichText';

const examples = ['Directory', 'Lists', 'Forms', 'Choices', 'Typography', 'Sending', 'Conversation', 'Toolbar', 'Empty', 'Loading', 'Error'] as const;
type Example = typeof examples[number];

/** Development-only reference: feature screens should compose these same building blocks. */
export function ComponentGallery() {
  const [appearance, setAppearance] = useState<'light' | 'dark'>('light');
  if (!__DEV__) return <Redirect href="/" />;
  return <ThemeProvider appearance={appearance}><Gallery appearance={appearance} onAppearance={() => setAppearance(value => value === 'light' ? 'dark' : 'light')} /></ThemeProvider>;
}

function Gallery({ appearance, onAppearance }: { appearance: 'light' | 'dark'; onAppearance: () => void }) {
  // Preview native chrome and alerts too; restore the app's system preference on exit.
  useFocusEffect(useCallback(() => {
    Appearance.setColorScheme(appearance);
    return () => Appearance.setColorScheme('auto');
  }, [appearance]));
  const [example, setExample] = useState<Example>('Lists');
  const [busyToolbar, setBusyToolbar] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [selection, setSelection] = useState('all');
  const [many, setMany] = useState<string[]>(['0']);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<'short' | 'long' | null>(null);
  const [name, setName] = useState('Jaden');
  const [date, setDate] = useState('2026-11-04');
  const [time, setTime] = useState('09:00');
  const { spacing, colors } = useTheme();
  const shortChoices = [{ value: 'all', label: 'All records' }, { value: 'mine', label: 'Assigned to me' }, { value: 'done', label: 'Completed' }];
  const longChoices = Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: `Option ${index + 1}` }));
  const form = editing && <ExampleForm long={editing === 'long'} name={name} onSave={setName} onClose={() => setEditing(null)} />;
  const chrome = <><RouterStack.Screen options={{ title: example, statusBarStyle: appearance === 'dark' ? 'light' : 'dark', headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.link, headerTitleStyle: { color: colors.text } }} />{example !== 'Directory' && <HeaderMenu label="Component examples" actions={[
    { id: 'examples', title: 'Examples', items: examples.map(value => ({ id: value, title: value, selected: value === example })) },
    { id: 'appearance', title: appearance === 'light' ? 'Dark appearance' : 'Light appearance' },
  ]} onAction={id => { if (id === 'appearance') onAppearance(); else if (examples.includes(id as Example)) { setExample(id as Example); setNotice(''); } }} />}</>;
  let content;
  if (example === 'Lists' || example === 'Forms') content = <Screen nativeScroll padded={false}>
    <SettingsList sections={example === 'Lists' ? [
      { id: 'account', title: 'Account', rows: [{ id: 'profile', title: name, subtitle: 'Profile and preferences', leading: <Avatar name={name} />, onPress: () => setEditing('short') }] },
      { id: 'values', title: 'Workspace', rows: [
        { id: 'name', title: 'Name', value: 'Companybot', onPress: () => setNotice('Workspace row selected') },
        { id: 'people', title: 'Members', value: '12 people', icon: { ios: 'person.2', android: 'group', web: 'group' }, onPress: () => setNotice('Members row selected') },
        { id: 'long', title: 'A longer row label that needs room to wrap', value: 'A long value remains readable', onPress: () => setNotice('Long row selected') },
        { id: 'disabled', title: 'Unavailable action', value: 'Read only', disabled: true, onPress: () => {} },
      ] },
      { id: 'preferences', title: 'Preferences', footer: notice || 'Rows use system spacing and wrap with larger text.', rows: [
        { id: 'notifications', kind: 'toggle', title: 'Notifications', subtitle: 'Updates from your team', value: enabled, onValueChange: setEnabled },
        { id: 'locked', kind: 'toggle', title: 'Managed preference', value: true, disabled: true, onValueChange: () => {} },
      ] },
    ] : [
      { id: 'profile', title: 'Profile', footer: 'Editing starts with a deliberate action.', rows: [
        { id: 'name', title: 'Name', value: name, onPress: () => setEditing('short') },
        { id: 'edit', title: 'Edit profile', onPress: () => setEditing('short') },
        { id: 'long-form', title: 'Long form and inline choices', subtitle: 'Verify scrolling, keyboard and large text', onPress: () => setEditing('long') },
      ] },
    ]} />{form}
  </Screen>;
  else if (example === 'Directory') content = <DirectoryExample menu={[...examples.filter(value => value !== 'Directory').map(value => ({ label: value, onPress: () => setExample(value) })), { label: appearance === 'light' ? 'Dark appearance' : 'Light appearance', onPress: onAppearance }]} />;
  else if (example === 'Empty' || example === 'Loading' || example === 'Error') content = <FeedbackExample key={example} kind={example} />;
  else if (example === 'Sending') content = <Screen scroll padded={false}><PendingMessageRow name="Alexandra Morgan with a longer display name" text="Here is the project summary for our next review. This longer message should wrap naturally with larger text sizes." files={2} dayLabel="Today" /><PendingMessageRow name="Alex Morgan" text="" files={1} /></Screen>;
  else if (example === 'Conversation') content = <ConversationExample />;
  else if (example === 'Toolbar') content = <Screen padded={false}><View style={{ flex: 1, padding: spacing.lg }}><Text>A bounded content area fills the available space.</Text><Button label={busyToolbar ? "Finish saving" : "Preview busy toolbar"} variant="secondary" onPress={() => setBusyToolbar(value => !value)} />{notice ? <Text tone="muted">{notice}</Text> : null}</View><ContentToolbar busy={busyToolbar} status={busyToolbar ? "Saving…" : "All changes saved"} actions={[
    { id: 'edit', label: 'Edit', icon: { ios: 'pencil', android: Edit }, onPress: () => setNotice('Edit selected') },
    { id: 'image', label: 'Add image (unavailable)', disabled: true, icon: { ios: 'photo.badge.plus', android: Photo }, onPress: () => setNotice('Image selected') },
    { id: 'history', label: 'History', icon: { ios: 'clock', android: History }, onPress: () => setNotice('History selected') },
    { id: 'duplicate', label: 'Duplicate', icon: { ios: 'doc.on.doc', android: Edit }, onPress: () => setNotice('Duplicate selected') },
    { id: 'unavailable', label: 'Unavailable overflow action', icon: { ios: 'lock', android: More }, disabled: true, onPress: () => setNotice('This disabled action must not run') },
  ]} /></Screen>;
  else content = <Screen scroll><Stack gap="xl">
    {example === 'Choices' ? <>
      <Section title="Compact menus"><Stack horizontal style={{ flexWrap: 'wrap' }}><ChoicePicker presentation="compact" label="View" options={shortChoices} value={selection} onChange={value => { if (typeof value === 'string') setSelection(value); }} /><ChoicePicker presentation="compact" label="Unavailable" options={shortChoices} value="mine" onChange={() => {}} disabled /></Stack></Section>
      <Section title="Form rows"><ChoicePicker label="View" options={shortChoices} value={selection} onChange={value => { if (typeof value === 'string') setSelection(value); }} /><ChoicePicker label="Multiple selections" multiple options={longChoices} value={many} onChange={value => { if (Array.isArray(value)) setMany(value); }} /><DateInput label="Date" value={date} onChange={setDate} /><TimeInput label="Time" value={time} onChange={setTime} /><TimeInput label="A longer time label that needs room to wrap" value="23:45" onChange={() => {}} disabled /></Section>
    </> : <>
      <Section title="System typography"><Text variant="title">A clear page title</Text><Text variant="heading">Section heading</Text><Text>Body text uses the system font and follows the device’s text size.</Text><Text variant="supporting" tone="muted">Supporting information stays secondary.</Text><Text variant="caption" tone="muted">Metadata · 9:41 AM</Text></Section>
      <Section title="Formatted content"><RichText value={'## A heading with **bold** and `code`\n\nBody text with **bold _italic_** and a [**formatted link**](https://example.com).'} /></Section>
      <Section title="Custom content rows"><View>
        <ListRow title="A content item" description="Useful supporting detail" value="Today" disclosure onPress={() => setNotice('Opened item')} />
        <ListRow title="A longer title that wraps across several lines at larger text sizes" description="Rows grow with their content. This supporting text must stay above the next row without relying on extra space between rows." disclosure onPress={() => setNotice('Opened long item')} />
        <ListRow title="Read-only content can still be copied." description="Press and hold the text to select it." selectable />
        <ListRow title="Separate menu target" description="The menu does not open this row" onPress={() => setNotice('Opened row')} trailing={<ActionMenu label="Item actions" actions={[{ id: 'pin', title: 'Pin', icon: 'pin' }]} onAction={() => setNotice('Menu selected')} />} />
      </View></Section>
      <Section title="Record properties"><Stack gap="none"><PropertyRow label="Status" value="In progress" onPress={() => setNotice('Edit status')} /><PropertyRow label="A longer property label" value="A longer value should remain readable and wrap at larger text sizes." /><PropertyRow label="Managed value" value="Read only" disabled onPress={() => {}} /></Stack></Section>
      <Section title="Button hierarchy"><Stack horizontal style={{ flexWrap: 'wrap' }}><Button label="Save" onPress={() => setNotice('Save selected')} /><Button label="Cancel" variant="ghost" onPress={() => setNotice('Cancel selected')} /><Button label="Unavailable" disabled /><Button label="Saving" loading /><Button label="Delete" variant="danger" onPress={() => setNotice('Delete selected')} /></Stack></Section>
      {!!notice && <Text tone="muted">{notice}</Text>}
    </>}
  </Stack></Screen>;
  return <>{chrome}{content}</>;
}

function ExampleForm({ name, long = false, onSave, onClose }: { name: string; long?: boolean; onSave: (name: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(name);
  const [role, setRole] = useState('member');
  const [notes, setNotes] = useState('');
  const [reviewers, setReviewers] = useState<string[]>([]);
  const guard = useDraftGuard({ dirty: draft !== name || role !== 'member' || !!notes || reviewers.length > 0, onClose });
  const save = () => { if (!draft.trim()) return; onSave(draft.trim()); guard.complete(); onClose(); };
  return <EditorSheet title="Edit profile" size="content" dismissible={guard.dismissible} onClose={() => void guard.close()} submit={{ onPress: save, disabled: !draft.trim() }}>
    {guard.dialog}<Field label="Name" value={draft} onChangeText={setDraft} textContentType="name" autoComplete="name" returnKeyType="done" />
    <ChoicePicker label="Role" value={role} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} onChange={value => { if (typeof value === 'string') setRole(value); }} />
    {long && <><ChoicePicker label="Reviewers" multiple value={reviewers} options={Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: `Reviewer ${index + 1}` }))} onChange={value => { if (Array.isArray(value)) setReviewers(value); }} /><Field label="Notes" hint="The form should scroll when its content exceeds the sheet, including with the keyboard open." multiline value={notes} onChangeText={setNotes} /></>}
  </EditorSheet>;
}
