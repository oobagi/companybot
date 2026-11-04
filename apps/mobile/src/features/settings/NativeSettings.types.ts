export type SettingsGroup = { title: string; rows: { id: string; label: string; description: string; onPress: () => void }[] };
export type NativeSettingsProps = {
  name: string;
  email?: string;
  image?: string | null;
  onAccount: () => void;
  groups: SettingsGroup[];
  onSignOut: () => void;
  signingOut: boolean;
  error?: string | null;
};
