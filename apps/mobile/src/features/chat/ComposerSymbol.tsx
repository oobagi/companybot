import { ArrowUp, Plus } from 'phosphor-react-native';

export function ComposerSymbol({ name, color }: { name: 'add' | 'send'; color: string }) {
  const Icon = name === 'add' ? Plus : ArrowUp;
  return <Icon color={color} size={24} />;
}
