import type { ReactNode } from 'react';
import { EditorSheet } from '@/components/ui';

/** Native modal owns its safe areas and Android back dismissal. */
export function Dialog({ title, onClose, children, busy = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
  return <EditorSheet title={title} onClose={onClose} busy={busy}>{children}</EditorSheet>;
}
