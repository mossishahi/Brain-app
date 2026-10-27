import { LuSearch, LuArchive } from 'react-icons/lu';
import type { LibrarySection } from './routes';

/** Library contributions open beside the main view, never replace it. */
export const libraryNavigation = [
  { id: 'history', label: 'Research history', icon: LuSearch },
  { id: 'trash', label: 'Trash', icon: LuArchive },
] as const satisfies readonly { id: LibrarySection; label: string; icon: typeof LuSearch }[];
