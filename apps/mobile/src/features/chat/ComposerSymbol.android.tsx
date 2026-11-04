import { Host, Icon } from '@expo/ui/jetpack-compose';
import Add from '@expo/material-symbols/add.xml';
import Send from '@expo/material-symbols/arrow_upward.xml';

export function ComposerSymbol({ name, color }: { name: 'add' | 'send'; color: string }) {
  return <Host pointerEvents="none" matchContents style={{ width: 24, height: 24 }}><Icon source={name === 'add' ? Add : Send} size={24} tint={color} /></Host>;
}
