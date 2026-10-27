import type { ReactNode } from 'react';

interface QuickControlBase {
  id: string;
  label: string;
  description?: string;
  scope?: string;
  value?: string;
  reason?: string;
  disabled?: boolean;
  pending?: boolean;
  error?: string;
  icon?: ReactNode;
  keywords?: string;
}
export type QuickControlItem = QuickControlBase & (
  | { kind: 'submenu'; children: readonly QuickControlItem[]; contentDescription?: string }
  | { kind: 'toggle'; checked: boolean; onChange: (checked: boolean) => void }
  | { kind: 'choice'; selected: boolean; onSelect: () => void }
  | { kind: 'action'; onSelect: () => void; keepOpen?: boolean }
);
export type QuickControlSubmenu = Extract<QuickControlItem, { kind: 'submenu' }>;
