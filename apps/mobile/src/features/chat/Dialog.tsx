import type { ReactNode } from 'react';
import { EditorSheet } from '@/components/ui';

/** Native modal owns its safe areas and Android back dismissal. */
export function Dialog({ title, onClose, children, busy = false, dismissible = true }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean; dismissible?: boolean }) {
  return <EditorSheet title={title} onClose={onClose} busy={busy} dismissible={dismissible}>{children}</EditorSheet>;
}
