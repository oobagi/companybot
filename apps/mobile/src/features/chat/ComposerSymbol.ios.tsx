import { Host, Image } from '@expo/ui/swift-ui';

/** Decorative symbols; the surrounding button or menu owns accessibility. */
export function ComposerSymbol({ name, color }: { name: 'add' | 'send'; color: string }) {
  return <Host pointerEvents="none" matchContents ignoreSafeArea="all" style={{ width: 24, height: 24 }}><Image systemName={name === 'add' ? 'plus' : 'arrow.up.circle.fill'} size={24} color={color} /></Host>;
}
