import type { ChoiceMenuProps } from './ChoiceMenu.types';

/** Web uses the searchable choice sheet; native entrypoints supply platform menus. */
export function ChoiceMenu({ children }: ChoiceMenuProps) { return <>{children}</>; }
